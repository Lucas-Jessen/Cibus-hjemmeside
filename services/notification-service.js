// Tracks changes per workspace area and emails users who have switched notifications on for that area.
//
// The portal only reads its data (Excel files, the property export, Propbinder), so a "change" is a difference
// between two snapshots of an area: rows added, removed, or with a changed field. The first snapshot of an area
// is a baseline and sends nothing.

const MAX_ITEMS_PER_AREA = 25;

function ensureNotificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      area TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, area)
    );
    CREATE TABLE IF NOT EXISTS area_snapshots (
      area TEXT PRIMARY KEY,
      snapshot TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      areas TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
}

const normalizeValue = (value) => (value == null || value === '' ? null : String(value));

// items: [{ key, label, fields: { Label: value } }] -> stored map key -> { label, fields }
function toSnapshot(items) {
  const snapshot = {};
  for (const item of items) {
    if (item.key == null || item.key === '') continue;
    snapshot[String(item.key)] = {
      label: String(item.label || item.key),
      fields: Object.fromEntries(Object.entries(item.fields || {}).map(([name, value]) => [name, normalizeValue(value)])),
    };
  }
  return snapshot;
}

function diffSnapshots(previous, next) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, item] of Object.entries(next)) {
    const before = previous[key];
    if (!before) {
      added.push({ key, label: item.label });
      continue;
    }
    const fields = [...new Set([...Object.keys(before.fields), ...Object.keys(item.fields)])]
      .filter((name) => (before.fields[name] ?? null) !== (item.fields[name] ?? null))
      .map((name) => ({ field: name, from: before.fields[name] ?? null, to: item.fields[name] ?? null }));
    if (fields.length) changed.push({ key, label: item.label, fields });
  }
  for (const [key, item] of Object.entries(previous)) {
    if (!next[key]) removed.push({ key, label: item.label });
  }
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}

const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const show = (value) => (value == null ? '(tom)' : value);

function describeChanges(diff) {
  const lines = [];
  for (const item of diff.added) lines.push({ kind: 'Ny', label: item.label, detail: '' });
  for (const item of diff.changed) lines.push({ kind: 'Ændret', label: item.label, detail: item.fields.map((change) => `${change.field}: ${show(change.from)} → ${show(change.to)}`).join('; ') });
  for (const item of diff.removed) lines.push({ kind: 'Fjernet', label: item.label, detail: '' });
  return lines;
}

function buildEmail({ user, areaChanges, baseUrl }) {
  const areaNames = areaChanges.map(({ area }) => area.label);
  const subject = `Cibus-portalen: ændringer i ${areaNames.join(', ')}`;
  const textParts = [`Hej ${user.name}`, '', 'Der er registreret ændringer i de arbejdsområder, du følger:'];
  const htmlParts = [`<p>Hej ${escapeHtml(user.name)}</p>`, '<p>Der er registreret ændringer i de arbejdsområder, du følger:</p>'];
  for (const { area, diff } of areaChanges) {
    const counts = `${diff.added.length} nye, ${diff.changed.length} ændrede, ${diff.removed.length} fjernede`;
    const url = `${baseUrl.replace(/\/+$/, '')}${area.href}`;
    const lines = describeChanges(diff);
    const shown = lines.slice(0, MAX_ITEMS_PER_AREA);
    textParts.push('', `${area.label} (${counts})`, ...shown.map((line) => `- ${line.kind}: ${line.label}${line.detail ? ` – ${line.detail}` : ''}`));
    if (lines.length > shown.length) textParts.push(`- … og ${lines.length - shown.length} flere`);
    textParts.push(`Se området: ${url}`);
    htmlParts.push(
      `<h3 style="margin:18px 0 6px">${escapeHtml(area.label)} <span style="font-weight:normal;color:#75848e">(${escapeHtml(counts)})</span></h3>`,
      '<ul style="margin:0;padding-left:18px">',
      ...shown.map((line) => `<li><strong>${escapeHtml(line.kind)}:</strong> ${escapeHtml(line.label)}${line.detail ? ` <span style="color:#4e5954">– ${escapeHtml(line.detail)}</span>` : ''}</li>`),
      lines.length > shown.length ? `<li>… og ${lines.length - shown.length} flere</li>` : '',
      '</ul>',
      `<p><a href="${escapeHtml(url)}">Åbn ${escapeHtml(area.label)} i portalen</a></p>`,
    );
  }
  textParts.push('', 'Du får denne mail, fordi du har slået notifikationer til under Indstillinger → Notifikationer.');
  htmlParts.push('<p style="color:#75848e;font-size:12px">Du får denne mail, fordi du har slået notifikationer til under Indstillinger → Notifikationer.</p>');
  return { subject, text: textParts.join('\n'), html: htmlParts.filter(Boolean).join('\n') };
}

// areas: [{ key, label, href, adminOnly, load: async () => ({ items, complete }) }]
function createNotificationService({ db, areas, mailer = null, baseUrl = 'http://127.0.0.1:3000', logger = console, maxAttempts = 5 }) {
  ensureNotificationSchema(db);
  const areaByKey = new Map(areas.map((area) => [area.key, area]));
  let running = null;

  const canSee = (user, area) => !area.adminOnly || user.role === 'admin';

  function getPreferences(user) {
    const rows = db.prepare('SELECT area, enabled FROM notification_preferences WHERE user_id = ?').all(user.id);
    const enabled = new Map(rows.map((row) => [row.area, Boolean(row.enabled)]));
    return areas.filter((area) => canSee(user, area)).map((area) => ({ key: area.key, label: area.label, description: area.description || '', enabled: enabled.get(area.key) || false }));
  }

  function setPreferences(user, enabledKeys) {
    const wanted = new Set(enabledKeys);
    const upsert = db.prepare(`INSERT INTO notification_preferences (user_id, area, enabled, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, area) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`);
    db.transaction(() => {
      for (const area of areas) if (canSee(user, area)) upsert.run(user.id, area.key, wanted.has(area.key) ? 1 : 0);
    })();
  }

  function recentForUser(user, limit = 5) {
    return db.prepare('SELECT subject, areas, created_at, sent_at, last_error FROM notification_outbox WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, limit);
  }

  async function checkArea(area) {
    let result;
    try {
      result = await area.load();
    } catch (error) {
      logger.error(`Notifikationer: ${area.label} kunne ikke læses: ${error.message}`);
      return null;
    }
    if (!result || result.complete === false) return null;
    const next = toSnapshot(result.items || []);
    const row = db.prepare('SELECT snapshot, item_count FROM area_snapshots WHERE area = ?').get(area.key);
    const count = Object.keys(next).length;
    // An empty or collapsed source (file missing, filter failed) would look like every row was removed; skip it.
    if (row && row.item_count > 0 && count < row.item_count * 0.5) {
      logger.error(`Notifikationer: ${area.label} gav ${count} rækker mod ${row.item_count} sidst; springer over.`);
      return null;
    }
    db.prepare(`INSERT INTO area_snapshots (area, snapshot, item_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(area) DO UPDATE SET snapshot = excluded.snapshot, item_count = excluded.item_count, updated_at = CURRENT_TIMESTAMP`).run(area.key, JSON.stringify(next), count);
    if (!row) return null; // baseline
    const diff = diffSnapshots(JSON.parse(row.snapshot), next);
    return diff.total ? diff : null;
  }

  async function sendPending() {
    if (!mailer) return { sent: 0, pending: db.prepare('SELECT COUNT(*) AS count FROM notification_outbox WHERE sent_at IS NULL').get().count };
    const pending = db.prepare('SELECT * FROM notification_outbox WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT 50').all(maxAttempts);
    let sent = 0;
    for (const message of pending) {
      try {
        await mailer.send({ to: message.recipient, subject: message.subject, text: message.body_text, html: message.body_html });
        db.prepare('UPDATE notification_outbox SET sent_at = CURRENT_TIMESTAMP, attempts = attempts + 1, last_error = NULL WHERE id = ?').run(message.id);
        sent += 1;
      } catch (error) {
        db.prepare('UPDATE notification_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(error.message).slice(0, 500), message.id);
        logger.error(`Notifikationer: mail til ${message.recipient} fejlede: ${error.message}`);
      }
    }
    return { sent, pending: pending.length - sent };
  }

  async function runOnce() {
    const changes = [];
    for (const area of areas) {
      const diff = await checkArea(area);
      if (diff) changes.push({ area, diff });
    }
    let queued = 0;
    if (changes.length) {
      const subscribers = db.prepare(`SELECT u.id, u.name, u.email, u.role, p.area FROM notification_preferences p
        JOIN users u ON u.id = p.user_id WHERE p.enabled = 1 AND u.active = 1`).all();
      const byUser = new Map();
      for (const row of subscribers) {
        if (!byUser.has(row.id)) byUser.set(row.id, { user: { id: row.id, name: row.name, email: row.email, role: row.role }, areas: new Set() });
        byUser.get(row.id).areas.add(row.area);
      }
      const insert = db.prepare('INSERT INTO notification_outbox (user_id, recipient, areas, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?, ?)');
      for (const { user, areas: followed } of byUser.values()) {
        const areaChanges = changes.filter(({ area }) => followed.has(area.key) && canSee(user, area));
        if (!areaChanges.length) continue;
        const email = buildEmail({ user, areaChanges, baseUrl });
        insert.run(user.id, user.email, areaChanges.map(({ area }) => area.key).join(','), email.subject, email.text, email.html);
        queued += 1;
      }
    }
    const delivery = await sendPending();
    return { changedAreas: changes.map(({ area, diff }) => ({ area: area.key, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length })), queued, ...delivery };
  }

  return {
    areas: areas.map(({ key, label, href, adminOnly, description }) => ({ key, label, href, adminOnly: Boolean(adminOnly), description: description || '' })),
    get mailConfigured() {
      return Boolean(mailer);
    },
    getPreferences,
    setPreferences,
    recentForUser,
    hasArea: (key) => areaByKey.has(key),
    // Runs are serialized so a slow area (Propbinder) cannot overlap the next scheduled check.
    run() {
      running ||= runOnce().finally(() => { running = null; });
      return running;
    },
  };
}

module.exports = { createNotificationService, diffSnapshots, toSnapshot, buildEmail, ensureNotificationSchema };
