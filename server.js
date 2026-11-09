require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const Knex = require('knex');
const { ConnectSessionKnexStore: KnexSessionStore } = require('connect-session-knex');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createPropbinderService, parseStatusLabels } = require('./services/propbinder-service');
const { createPropbinderClient } = require('./services/propbinder-client');
const { buildTaskAnalytics, buildCreationChart } = require('./services/propbinder-analytics');
const { createPropertyRegisterService, createSharePointPropertyRegister, FIELDS: PROPERTY_REGISTER_FIELDS } = require('./services/property-register-service');
const { createSharePointListClient } = require('./services/sharepoint-list-client');
const { createNotificationService } = require('./services/notification-service');
const { createGraphMailer } = require('./services/mailer');
const { createPropertyMatcher } = require('./services/cibus-property-matcher');
const { createInspectionService, buildInspectionAnalytics, AGE_BUCKETS } = require('./services/inspection-service');
const { createReportService, buildReportAnalytics } = require('./services/report-service');

const CUSTOMER = process.env.PROPERTY_REGISTER_CUSTOMER || 'Cibus Real Estate';
const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
// DATA_DIR lets a host keep the database outside the deployed code (e.g. /home/data on Azure App Service).
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'cibus.sqlite');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'normal',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
const database = Knex({ client: 'better-sqlite3', connection: { filename: dbFile }, useNullAsDefault: true });
const sessionStore = new KnexSessionStore({ knex: database, tableName: 'sessions', createTable: true, cleanupInterval: 15 * 60 * 1000 });

// Ejendomme: the SharePoint list "Ejendomsoversigt", only rows with Kunde1 = Cibus Real Estate.
const propertyRegisterListClient = process.env.PROPERTY_REGISTER_SHAREPOINT_SITE ? createSharePointListClient({
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  site: process.env.PROPERTY_REGISTER_SHAREPOINT_SITE,
  listName: process.env.PROPERTY_REGISTER_SHAREPOINT_LIST || 'Ejendomsoversigt',
  columns: [...PROPERTY_REGISTER_FIELDS.map(([, header]) => header), 'EjendomsNr'],
  where: { column: 'Kunde1', equals: CUSTOMER },
}) : null;
const propertyRegisterService = propertyRegisterListClient
  ? createSharePointPropertyRegister({ listClient: propertyRegisterListClient, customer: CUSTOMER, cacheTtlMs: (Number(process.env.PROPERTY_REGISTER_REFRESH_MINUTES) || 10) * 60 * 1000 })
  : createPropertyRegisterService({ sourcePath: process.env.PROPERTY_REGISTER_PATH || null, customer: CUSTOMER });

// Propbinder only shows tasks on the Cibus properties. The Propbinder service reads its property list
// synchronously, so this adapter keeps the latest SharePoint result in memory (loaded at startup and refreshed
// with the register). EjendomNr matches Propbinder's financeUnit.
let cibusPropertyList = null;
// All Cibus properties (also ceased) for linking Tilsyn and Rapporter rows to an EjendomNr.
let cibusRegister = [];
let cibusMatcher = null;
async function refreshCibusPropertyList() {
  const result = await propertyRegisterService.getProperties();
  cibusRegister = result.properties;
  cibusMatcher = createPropertyMatcher(result.properties);
  const properties = result.properties
    .filter((p) => p.number && p.status !== 'OPHØRT')
    .map((p) => ({
      number: String(p.number).trim().toUpperCase(), name: p.name || p.number, address: [p.address, p.address2].filter(Boolean).join(', ') || null, zipCode: p.zipCode, city: p.city, segment: p.segment, portfolio: p.portfolio,
      // Each address on its own, for finding the property in a Propbinder task's text.
      textKeys: [p.address, ...String(p.address2 || '').split(',')].map((text) => (text || '').trim()).filter(Boolean),
    }));
  cibusPropertyList = { properties, byNumber: new Map(properties.map((p) => [p.number, p])), modifiedAt: result.modifiedAt };
  return cibusPropertyList;
}
const propertyListAdapter = {
  get configured() { return propertyRegisterService.configured; },
  getProperties() {
    if (!cibusPropertyList) throw new Error('Cibus-ejendommene er endnu ikke hentet fra SharePoint. Prøv igen om lidt.');
    return cibusPropertyList;
  },
};

const propbinderMode = (process.env.PROPBINDER_MODE || 'mock').toLowerCase();
const propbinderClient = propbinderMode === 'live' && process.env.PROPBINDER_USERNAME && process.env.PROPBINDER_PASSWORD
  ? createPropbinderClient({
    baseUrl: process.env.PROPBINDER_API_BASE_URL || undefined,
    username: process.env.PROPBINDER_USERNAME,
    password: process.env.PROPBINDER_PASSWORD,
    timeoutMs: Number(process.env.PROPBINDER_TIMEOUT_SECONDS) * 1000 || undefined,
  })
  : null;
const propbinderService = createPropbinderService({
  mode: propbinderMode,
  backendClient: propbinderClient,
  statusLabels: parseStatusLabels(process.env.PROPBINDER_TASK_STATUSES),
  propertyList: propertyListAdapter,
  timeRegistrationLookbackDays: Number(process.env.PROPBINDER_TIMEREG_LOOKBACK_DAYS) || 1095,
  // GetTasks has no property, and few Cibus tasks have time registrations; also link by address/name/lease code
  // in the task text. Set PROPBINDER_TEXT_MATCHING=false to show only tasks linked by Propbinder's own data.
  textMatching: String(process.env.PROPBINDER_TEXT_MATCHING || 'true').toLowerCase() !== 'false',
});

// Tilsyn (Excel) and Rapporter og afvigelser (PDF). Each path may be a folder: the newest Excel file and
// every PDF in it are read, so a new month only has to be dropped into the folder.
const inspectionService = createInspectionService({ sourcePath: process.env.TILSYN_PATH || path.join(__dirname, 'kildefiler', 'tilsyn'), getMatcher: () => cibusMatcher });
const reportService = createReportService({ sourcePath: process.env.RAPPORTER_PATH || path.join(__dirname, 'kildefiler', 'rapporter'), getMatcher: () => cibusMatcher });

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const notificationAreas = [
  propertyRegisterService.configured && {
    key: 'properties', label: 'Ejendomme', href: '/workspaces/properties', description: 'Nye, ophørte og ændrede Cibus-ejendomme i ejendomsoversigten.',
    load: async () => ({ items: (await propertyRegisterService.getProperties()).properties.map((p) => ({
      key: p.number || p.name, label: `${p.name}${p.number ? ` (${p.number})` : ''}`,
      fields: { Status: p.status, Portefølje: p.portfolio, Segment: p.segment, Adresse: [p.address, p.city].filter(Boolean).join(', '), Inspektør: p.inspector, 'Asset Manager': p.assetManager, Ejer: p.owner },
    })) }),
  },
  {
    key: 'tilsyn', label: 'Tilsyn', href: '/tilsyn?view=liste', description: 'Nye tilsynsdatoer og ændrede bemærkninger.',
    load: async () => ({ items: inspectionService.getInspections().inspections.map((item) => ({ key: item.name, label: `${item.name}${item.propertyNumber ? ` (${item.propertyNumber})` : ''}`, fields: { 'Seneste tilsyn': day(item.latest), 'Forrige tilsyn': day(item.previous), Bemærkning: item.remark } })) }),
  },
  {
    key: 'rapporter', label: 'Rapporter og afvigelser', href: '/rapporter?view=liste', description: 'Nye rapporter og afvigelser fra de månedlige udtræk.',
    load: async () => {
      const { reports, deviations } = await reportService.getReports();
      // The same report can appear twice (same minute and place); number the repeats so keys stay stable.
      const seen = new Map();
      const keyOf = (item) => { const base = `${item.section}|${item.date}|${item.time}|${item.location}|${item.schema}`; const n = (seen.get(base) || 0) + 1; seen.set(base, n); return n === 1 ? base : `${base}#${n}`; };
      return { items: [...reports, ...deviations].map((item) => ({ key: keyOf(item), label: `${item.section === 'afvigelser' ? 'Afvigelse' : 'Rapport'}: ${item.category} – ${item.propertyName || item.place}`, fields: { Dato: item.date, Bruger: item.user } })) };
    },
  },
  propbinderMode === 'live' && {
    key: 'propbinder', label: 'Propbinder-opgaver', href: '/propbinder-tasks?section=opgaveliste', adminOnly: true, description: 'Nye opgaver og ændret status, frist eller ansvarlig.',
    load: async () => {
      const tasks = await propbinderService.getTasks();
      if (propbinderService.getConfiguration().warnings.length) return { items: [], complete: false };
      return { items: tasks.map((t) => ({ key: t.id, label: `#${t.id} ${t.title}${t.property ? ` – ${t.property}` : ''}`, fields: { Status: t.status, Frist: day(t.dueDate), Ansvarlig: t.assignedTo } })) };
    },
  },
].filter(Boolean);
const notificationMailer = createGraphMailer({
  tenantId: process.env.NOTIFY_TENANT_ID || process.env.AZURE_TENANT_ID,
  clientId: process.env.NOTIFY_CLIENT_ID || process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.NOTIFY_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET,
  sender: process.env.NOTIFY_MAIL_SENDER,
});
const notificationService = createNotificationService({ db, areas: notificationAreas, mailer: notificationMailer, baseUrl: process.env.PORTAL_BASE_URL || `http://127.0.0.1:${port}` });

const defaults = { company_name: 'Cibus Real Estate', contact_email: 'kontakt@forenede.dk', timezone: 'Europe/Copenhagen' };
for (const [key, value] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
const initialEmail = process.env.ADMIN_EMAIL || 'admin@cibus.local';
const initialPassword = process.env.ADMIN_PASSWORD;
const hasUsers = Boolean(db.prepare('SELECT id FROM users LIMIT 1').get());
if (!process.env.SESSION_SECRET || (!hasUsers && !initialPassword)) {
  throw new Error('Set SESSION_SECRET and, for a new database, ADMIN_PASSWORD in the local environment.');
}
if (!hasUsers) {
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Cibus Admin', initialEmail, bcrypt.hashSync(initialPassword, 12), 'admin');
}

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  } catch {
    res.status(503).set('Cache-Control', 'no-store').json({ status: 'error' });
  }
});
app.use(session({
  name: 'cibus.sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: 'For mange forsøg. Prøv igen om lidt.' });
function validateOrigin(req, res, next) {
  const origin = req.get('origin');
  const submittedToken = Buffer.from(String(req.body?._csrf || ''));
  const expectedToken = Buffer.from(String(req.session.csrfToken || ''));
  if (!expectedToken.length || submittedToken.length !== expectedToken.length || !timingSafeEqual(submittedToken, expectedToken)) {
    return res.status(403).send('Anmodningen kunne ikke gennemføres.');
  }
  try {
    if (origin && origin !== 'null' && new URL(origin).host !== req.get('host')) return res.status(403).send('Anmodningen kunne ikke gennemføres.');
    const referer = req.get('referer');
    if (!origin && referer && new URL(referer).host !== req.get('host')) return res.status(403).send('Anmodningen kunne ikke gennemføres.');
  } catch {
    return res.status(403).send('Anmodningen kunne ikke gennemføres.');
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.user?.role !== 'admin') return res.status(403).render('error', { title: 'Ingen adgang', message: 'Du har ikke adgang til denne side.' });
  next();
}
function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}
const roleNames = { admin: 'Admin', normal: 'Normal', view: 'View' };
function pageData(req, extra = {}) {
  const settings = getSettings();
  settings.user_count = db.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get().count;
  return { user: req.session.user, settings, currentPath: req.path, roleNames, ...extra };
}

const propbinderSections = [['dashboard', 'Dashboard'], ['opgaveliste', 'Opgaveliste']];
function propbinderNavigation(req) {
  const activeKey = propbinderSections.some(([key]) => key === req.query.section) ? req.query.section : propbinderSections[0][0];
  return {
    title: 'Propbinder-opgaver',
    activeKey,
    tabs: propbinderSections.map(([key, label]) => ({ key, label, active: key === activeKey, href: `/propbinder-tasks?section=${key}` })),
    activeSection: propbinderSections.find(([key]) => key === activeKey)[1],
  };
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/workspaces/properties' : '/login'));
app.get('/dashboard', (req, res) => res.redirect('/workspaces/properties'));
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/workspaces/properties');
  res.render('login', { error: null });
});
app.post('/login', loginLimiter, validateOrigin, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT id, name, email, password_hash, role, active FROM users WHERE email = ?').get(email);
    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid || !user.active) return res.status(401).render('login', { error: 'E-mail eller adgangskode er forkert.' });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
      res.redirect('/workspaces/properties');
    });
  } catch (error) { next(error); }
});
app.post('/logout', validateOrigin, (req, res, next) => req.session.destroy((error) => {
  if (error) return next(error);
  res.clearCookie('cibus.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.redirect('/login');
}));

const propertiesWorkspace = { title: 'Ejendomme', singular: 'ejendom', description: 'Cibus Real Estates ejendomme fra ejendomsoversigten.', icon: '⌂' };
app.get('/workspaces/properties', requireAuth, async (req, res) => {
  let properties = [];
  let source = null;
  let error = null;
  try {
    const result = await propertyRegisterService.getProperties();
    properties = result.properties;
    source = { modifiedAt: result.modifiedAt, kind: result.source, warning: result.warning };
  } catch (loadError) {
    error = loadError.message;
  }
  res.render('properties', pageData(req, { workspace: propertiesWorkspace, properties, source, error, query: String(req.query.q || ''), statusFilter: String(req.query.status || '').toUpperCase(), portfolioFilter: String(req.query.portfolio || '') }));
});

app.get('/propbinder-tasks', requireAuth, requireAdmin, async (req, res) => {
  // Cases used to have their own tab; they are now part of the task list.
  if (req.query.section === 'sager') return res.redirect('/propbinder-tasks?section=opgaveliste&type=Sag');
  const sectionNav = propbinderNavigation(req);
  const listFilters = { property: String(req.query.property || ''), q: String(req.query.q || ''), status: String(req.query.status || ''), via: String(req.query.via || ''), type: String(req.query.type || ''), maaned: String(req.query.maaned || ''), dag: String(req.query.dag || '') };
  let tasks = [];
  let error = null;
  try {
    if (!cibusPropertyList && propertyRegisterService.configured) await refreshCibusPropertyList();
    tasks = await propbinderService.getTasks();
  } catch (fetchError) {
    error = fetchError.message;
  }
  res.render('propbinder-tasks', pageData(req, {
    tasks,
    sectionNav,
    listFilters,
    analytics: sectionNav.activeKey === 'dashboard' ? buildTaskAnalytics(tasks) : null,
    // Udvikling: one month per day (default the current month) or an interval of months.
    creationChart: sectionNav.activeKey === 'dashboard' ? buildCreationChart(tasks, { month: String(req.query.udv_maaned || ''), from: String(req.query.udv_fra || ''), to: String(req.query.udv_til || '') }) : null,
    service: propbinderService.getConfiguration(),
    error,
  }));
});

function viewNavigation(title, basePath, tabs, requested) {
  const activeKey = tabs.some(([key]) => key === requested) ? requested : tabs[0][0];
  return { title, activeKey, activeSection: tabs.find(([key]) => key === activeKey)[1], tabs: tabs.map(([key, label]) => ({ key, label, active: key === activeKey, href: `${basePath}?view=${key}` })) };
}
const queryFilters = (req, keys) => Object.fromEntries(['q', ...keys].map((key) => [key, String(req.query[key] || '')]));
async function ensureMatcher() {
  if (!cibusMatcher && propertyRegisterService.configured) await refreshCibusPropertyList().catch((error) => console.error('Ejendomme:', error.message));
}

app.get('/tilsyn', requireAuth, async (req, res) => {
  const viewNav = viewNavigation('Tilsyn', '/tilsyn', [['dashboard', 'Dashboard'], ['liste', 'Tilsynsliste']], req.query.view);
  let inspections = [];
  let source = null;
  let error = null;
  try {
    await ensureMatcher();
    const result = inspectionService.getInspections();
    inspections = result.inspections;
    source = { modifiedAt: result.modifiedAt, fileName: result.fileName };
  } catch (loadError) {
    error = loadError.message;
  }
  const inspected = new Set(inspections.map((item) => item.propertyNumber).filter(Boolean));
  const withoutInspection = cibusRegister.filter((property) => property.number && !inspected.has(property.number));
  res.render('tilsyn', pageData(req, {
    viewNav, view: viewNav.activeKey, inspections, source, error, buckets: AGE_BUCKETS, withoutInspection,
    listFilters: queryFilters(req, ['alder', 'region', 'type', 'bemaerkning']),
    analytics: viewNav.activeKey === 'dashboard' && !error ? buildInspectionAnalytics(inspections) : null,
  }));
});

app.get('/rapporter', requireAuth, async (req, res) => {
  const viewNav = viewNavigation('Rapporter og afvigelser', '/rapporter', [['dashboard', 'Dashboard'], ['liste', 'Rapportliste'], ['afvigelser', 'Afvigelser']], req.query.view);
  let data = { reports: [], deviations: [], files: [] };
  let error = null;
  try {
    await ensureMatcher();
    data = await reportService.getReports();
  } catch (loadError) {
    error = loadError.message;
  }
  res.render('rapporter', pageData(req, {
    viewNav, view: viewNav.activeKey, reports: data.reports, deviations: data.deviations, source: data.files.length ? { files: data.files, modifiedAt: data.modifiedAt } : null, error,
    listFilters: queryFilters(req, ['ejendom', 'kategori', 'type', 'bruger', 'frekvens']),
    analytics: viewNav.activeKey === 'dashboard' && !error ? buildReportAnalytics(data) : null,
  }));
});

// Users live under Indstillinger → Brugere. /users is kept as the target of the user forms.
const usersHref = (key, message) => `/settings?tab=brugere&${key}=${encodeURIComponent(message)}`;
app.get('/users', requireAuth, requireAdmin, (req, res) => {
  const params = new URLSearchParams({ tab: 'brugere' });
  for (const key of ['notice', 'error']) if (req.query[key]) params.set(key, String(req.query[key]));
  res.redirect('/settings?' + params.toString());
});
app.post('/users', requireAuth, requireAdmin, validateOrigin, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = ['admin', 'normal', 'view'].includes(req.body.role) ? req.body.role : 'normal';
    if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
      return res.redirect(usersHref('error', 'Kontrollér navn, e-mail og adgangskode (mindst 12 tegn).'));
    }
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, await bcrypt.hash(password, 12), role);
    res.redirect(usersHref('notice', 'Brugeren er oprettet.'));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.redirect(usersHref('error', 'E-mailadressen er allerede i brug.'));
    next(error);
  }
});
app.post('/users/:id/update', requireAuth, requireAdmin, validateOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return res.redirect(usersHref('error', 'Brugeren findes ikke.'));
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const problem = updateUserIdentity(id, { name, email });
  if (problem) return res.redirect(usersHref('error', problem));
  if (id === req.session.user.id) req.session.user = { ...req.session.user, name, email };
  res.redirect(usersHref('notice', 'Brugeren er opdateret.'));
});
app.post('/users/:id/toggle', requireAuth, requireAdmin, validateOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id === req.session.user.id) return res.redirect(usersHref('error', 'Denne handling kan ikke udføres.'));
  db.prepare('UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  res.redirect(usersHref('notice', 'Brugerens status er opdateret.'));
});

const SETTINGS_TABS = ['profil', 'brugere', 'notifikationer'];
const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: 'For mange forsøg. Prøv igen om lidt.' });
const profileHref = (key, message) => `/settings?tab=profil&${key}=${encodeURIComponent(message)}`;
app.get('/settings', requireAuth, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const requested = SETTINGS_TABS.includes(req.query.tab) ? req.query.tab : 'profil';
  const tab = requested === 'brugere' && !isAdmin ? 'profil' : requested;
  const profile = tab === 'profil' ? db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.session.user.id) : null;
  const users = tab === 'brugere' ? db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY id DESC').all() : [];
  const notifications = tab === 'notifikationer' ? {
    preferences: notificationService.getPreferences(req.session.user),
    recent: notificationService.recentForUser(req.session.user),
    mailConfigured: notificationService.mailConfigured,
    email: req.session.user.email,
  } : null;
  res.render('settings', pageData(req, { tab, isAdmin, users, notifications, profile, notice: req.query.notice || '', error: req.query.error || '' }));
});
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
function updateUserIdentity(id, { name, email }) {
  if (name.length < 2 || name.length > 80) return 'Navnet skal være mellem 2 og 80 tegn.';
  if (email !== undefined && !isValidEmail(email)) return 'Angiv en gyldig e-mailadresse.';
  if (email !== undefined && db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, id)) return 'E-mailadressen er allerede i brug.';
  if (email !== undefined) db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, id);
  else db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
  return null;
}
app.post('/settings/profile', requireAuth, validateOrigin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = req.session.user.role === 'admin' && req.body.email !== undefined ? String(req.body.email).trim().toLowerCase() : undefined;
  const problem = updateUserIdentity(req.session.user.id, { name, email });
  if (problem) return res.redirect(profileHref('error', problem));
  req.session.user = { ...req.session.user, name, ...(email !== undefined ? { email } : {}) };
  res.redirect(profileHref('notice', email !== undefined ? 'Din profil er opdateret.' : 'Dit navn er opdateret.'));
});
app.post('/settings/password', requireAuth, passwordLimiter, validateOrigin, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const next_ = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');
    const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
    if (!account || !(await bcrypt.compare(current, account.password_hash))) return res.redirect(profileHref('error', 'Den nuværende adgangskode er forkert.'));
    if (next_.length < 12 || next_.length > 128) return res.redirect(profileHref('error', 'Den nye adgangskode skal være mellem 12 og 128 tegn.'));
    if (next_ !== confirm) return res.redirect(profileHref('error', 'De to nye adgangskoder er ikke ens.'));
    if (next_ === current) return res.redirect(profileHref('error', 'Den nye adgangskode skal være forskellig fra den nuværende.'));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(next_, 12), req.session.user.id);
    res.redirect(profileHref('notice', 'Din adgangskode er ændret.'));
  } catch (error) {
    next(error);
  }
});
app.post('/settings/notifications', requireAuth, validateOrigin, (req, res) => {
  const selected = [].concat(req.body.areas || []).map(String).filter((key) => notificationService.hasArea(key));
  notificationService.setPreferences(req.session.user, selected);
  res.redirect('/settings?tab=notifikationer&notice=' + encodeURIComponent('Dine notifikationer er gemt.'));
});
app.post('/settings/notifications/run', requireAuth, requireAdmin, validateOrigin, async (req, res, next) => {
  try {
    const result = await notificationService.run();
    const changed = result.changedAreas.map((area) => area.area).join(', ') || 'ingen';
    res.redirect('/settings?tab=notifikationer&notice=' + encodeURIComponent(`Tjek kørt. Ændrede områder: ${changed}. Mails i kø: ${result.queued}, sendt: ${result.sent}.`));
  } catch (error) {
    next(error);
  }
});
app.post('/settings', requireAuth, requireAdmin, validateOrigin, (req, res) => {
  const values = {
    company_name: String(req.body.company_name || '').trim().slice(0, 80),
    contact_email: String(req.body.contact_email || '').trim().slice(0, 120),
    timezone: String(req.body.timezone || '').trim().slice(0, 50),
  };
  if (!values.company_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email) || !values.timezone) return res.redirect(profileHref('error', 'Kontrollér venligst virksomhedsoplysningerne.'));
  const save = db.transaction((entries) => entries.forEach(([key, value]) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)));
  save(Object.entries(values));
  res.redirect(profileHref('notice', 'Virksomhedsoplysningerne er gemt.'));
});
app.use((req, res) => res.status(404).render('error', { title: 'Siden blev ikke fundet', message: 'Den ønskede side findes ikke.' }));
app.use((error, req, res, next) => {
  console.error(error.message);
  if (res.headersSent) return next(error);
  res.status(500).render('error', { title: 'Noget gik galt', message: 'Siden kunne ikke indlæses. Prøv igen.' });
});

const server = app.listen(port, host, () => {
  console.log(`Cibus-portalen er klar på http://${host}:${port}`);
  const started = Date.now();
  // Load the Cibus properties first: the Propbinder filter needs them before tasks can be shown.
  const propertiesReady = propertyRegisterService.configured
    ? refreshCibusPropertyList()
      .then((list) => console.log(`Ejendomme: ${list.properties.length} aktive Cibus-ejendomme hentet på ${((Date.now() - started) / 1000).toFixed(1)} s.`))
      .catch((error) => console.error('Ejendomme: første hentning fejlede:', error.message))
    : Promise.resolve();
  const refreshMinutes = Number(process.env.PROPERTY_REGISTER_REFRESH_MINUTES) || 10;
  if (propertyRegisterService.configured) setInterval(() => refreshCibusPropertyList().catch((error) => console.error('Ejendomme: opdatering fejlede:', error.message)), refreshMinutes * 60 * 1000).unref();
  if (propbinderMode === 'live' && propbinderClient) {
    const describe = (tasks) => `${tasks.filter((task) => task.kind !== 'Sag').length} opgaver og ${tasks.filter((task) => task.kind === 'Sag').length} sager`;
    propertiesReady.then(() => propbinderService.getTasks())
      .then((tasks) => console.log(`Propbinder: ${describe(tasks)} på Cibus-ejendomme hentet på ${Math.round((Date.now() - started) / 1000)} s.`))
      .catch((error) => console.error('Propbinder: første hentning fejlede:', error.message));
    // Keep tasks and cases current without a page visit, so new cases from Propbinder show up during the day
    // (and reach the notifications).
    const propbinderMinutes = Number(process.env.PROPBINDER_REFRESH_MINUTES) || 15;
    setInterval(() => {
      propbinderService.refresh()
        .then((tasks) => console.log(`Propbinder: opdateret ${new Date().toLocaleTimeString('da-DK')} – ${describe(tasks)}.`))
        .catch((error) => console.error('Propbinder: opdatering fejlede:', error.message));
    }, propbinderMinutes * 60 * 1000).unref();
  }
  const notifyMinutes = Number(process.env.NOTIFY_INTERVAL_MINUTES || 15);
  if (notificationAreas.length && Number.isFinite(notifyMinutes) && notifyMinutes >= 1) {
    const check = () => notificationService.run()
      .then((result) => { if (result.changedAreas.length || result.queued) console.log('Notifikationer:', JSON.stringify(result)); })
      .catch((error) => console.error('Notifikationer: tjek fejlede:', error.message));
    setTimeout(check, 60 * 1000).unref();
    setInterval(check, notifyMinutes * 60 * 1000).unref();
  }
});
server.on('close', () => database.destroy());
