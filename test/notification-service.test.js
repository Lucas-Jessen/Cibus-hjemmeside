const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createNotificationService, diffSnapshots, toSnapshot } = require('../services/notification-service');
const { createGraphMailer } = require('../services/mailer');

function setup({ mailer = null } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, role TEXT, active INTEGER DEFAULT 1);
    INSERT INTO users (id, name, email, role, active) VALUES
      (1, 'Ada Admin', 'ada@example.com', 'admin', 1),
      (2, 'Nina Normal', 'nina@example.com', 'normal', 1),
      (3, 'Vera Inaktiv', 'vera@example.com', 'normal', 0);`);
  const data = {
    properties: [{ key: 'F1', label: 'Amerikavej', fields: { Status: 'AKTIV', Inspektør: 'Jan' } }, { key: 'F2', label: '8Tallet', fields: { Status: 'AKTIV', Inspektør: 'Søren' } }],
    tasks: [{ key: '1', label: '#1 Fejning', fields: { Status: 'Skal udføres' } }],
  };
  const areas = [
    { key: 'properties', label: 'Ejendomme', href: '/workspaces/properties', load: async () => ({ items: data.properties }) },
    { key: 'propbinder', label: 'Propbinder-opgaver', href: '/propbinder-tasks', adminOnly: true, load: async () => ({ items: data.tasks }) },
  ];
  const service = createNotificationService({ db, areas, mailer, baseUrl: 'https://portal.example', logger: { error: () => {} } });
  return { db, data, service };
}

const user = (id, role = 'normal') => ({ id, role, name: 'x', email: 'x@example.com' });

test('diffs snapshots into added, changed and removed rows with field changes', () => {
  const before = toSnapshot([{ key: 'A', label: 'A', fields: { Status: 'AKTIV', Budget: 100 } }, { key: 'B', label: 'B', fields: { Status: 'AKTIV' } }]);
  const after = toSnapshot([{ key: 'A', label: 'A', fields: { Status: 'OPHØRT', Budget: 100 } }, { key: 'C', label: 'C', fields: { Status: 'AKTIV' } }]);

  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added, [{ key: 'C', label: 'C' }]);
  assert.deepEqual(diff.removed, [{ key: 'B', label: 'B' }]);
  assert.deepEqual(diff.changed, [{ key: 'A', label: 'A', fields: [{ field: 'Status', from: 'AKTIV', to: 'OPHØRT' }] }]);
  assert.equal(diff.total, 3);
});

test('notifications are off by default and admin-only areas are hidden from other roles', () => {
  const { service } = setup();

  assert.deepEqual(service.getPreferences(user(2)).map((p) => [p.key, p.enabled]), [['properties', false]]);
  assert.deepEqual(service.getPreferences(user(1, 'admin')).map((p) => [p.key, p.enabled]), [['properties', false], ['propbinder', false]]);
  service.setPreferences(user(2), ['properties', 'propbinder']);
  assert.deepEqual(service.getPreferences(user(2)).map((p) => [p.key, p.enabled]), [['properties', true]]);
});

test('the first check is a baseline; later changes are mailed only to active followers of that area', async () => {
  const sent = [];
  const { db, data, service } = setup({ mailer: { send: async (message) => { sent.push(message); } } });
  service.setPreferences(user(1, 'admin'), ['propbinder']);
  service.setPreferences(user(2), ['properties']);
  db.prepare("INSERT INTO notification_preferences (user_id, area, enabled) VALUES (3, 'properties', 1)").run();

  const baseline = await service.run();
  assert.deepEqual(baseline.changedAreas, []);
  assert.equal(sent.length, 0);

  data.properties = [{ key: 'F1', label: 'Amerikavej', fields: { Status: 'OPHØRT', Inspektør: 'Jan' } }, data.properties[1], { key: 'F3', label: 'Enghavevej', fields: { Status: 'AKTIV', Inspektør: 'Kim' } }];
  const result = await service.run();

  assert.deepEqual(result.changedAreas, [{ area: 'properties', added: 1, changed: 1, removed: 0 }]);
  assert.equal(result.queued, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'nina@example.com');
  assert.match(sent[0].subject, /ændringer i Ejendomme/);
  assert.match(sent[0].text, /Ændret: Amerikavej – Status: AKTIV → OPHØRT/);
  assert.match(sent[0].text, /Ny: Enghavevej/);
  assert.match(sent[0].text, /https:\/\/portal\.example\/workspaces\/properties/);
  assert.equal(service.recentForUser(user(2))[0].sent_at !== null, true);
});

test('keeps mails in the outbox without a mailer and skips a collapsed source', async () => {
  const { data, service } = setup();
  service.setPreferences(user(2), ['properties']);
  data.properties.push({ key: 'F3', label: 'Enghavevej', fields: { Status: 'AKTIV', Inspektør: 'Kim' } });
  await service.run();

  data.properties = [data.properties[0]];
  const collapsed = await service.run();
  assert.equal(collapsed.changedAreas.length, 0);

  data.properties = [{ ...data.properties[0], fields: { Status: 'OPHØRT', Inspektør: 'Jan' } }, { key: 'F2', label: '8Tallet', fields: { Status: 'AKTIV', Inspektør: 'Søren' } }, { key: 'F3', label: 'Enghavevej', fields: { Status: 'AKTIV', Inspektør: 'Kim' } }];
  const result = await service.run();
  assert.equal(result.queued, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.pending, 1);
  assert.equal(service.recentForUser(user(2))[0].sent_at, null);
  assert.equal(service.mailConfigured, false);
});

test('Graph mailer posts the message for the sender mailbox', async () => {
  const calls = [];
  const mailer = createGraphMailer({
    tenantId: 't', clientId: 'c', clientSecret: 's', sender: 'portal@example.com',
    credential: { getToken: async () => ({ token: 'abc' }) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 202, text: async () => '' }; },
  });

  await mailer.send({ to: 'nina@example.com', subject: 'Hej', text: 'tekst', html: '<p>tekst</p>' });
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/users/portal%40example.com/sendMail');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer abc');
  assert.deepEqual(JSON.parse(calls[0].options.body).message.toRecipients, [{ emailAddress: { address: 'nina@example.com' } }]);
  assert.equal(createGraphMailer({ tenantId: 't', clientId: 'c', clientSecret: 's' }), null);
});
