const fs = require('fs');
const XLSX = require('xlsx');

// Columns from the "Ejendomsoversigt" export, in the order they are shown and searched.
// The same column names are used by the SharePoint list, so a later Graph source can reuse normalizeRegisterRow.
const FIELDS = [
  ['number', 'EjendomNr', 'Ejendomsnr.'],
  ['name', 'EjendomNavn', 'Ejendomsnavn'],
  ['address', 'Adresse', 'Adresse'],
  ['address2', 'Adresse2', 'Adresse 2'],
  ['zipCode', 'PostNr', 'Postnr.'],
  ['city', 'By', 'By'],
  ['status', 'Kundestatus - FSE', 'Status'],
  ['portfolio', 'Portefølje1', 'Portefølje'],
  ['segment', 'Segment', 'Segment'],
  ['debtorNumber', 'Kundenummer (Debitornummer)', 'Debitornr.'],
  ['workAreas', 'Arbejdsområder', 'Arbejdsområder'],
  ['inspector', 'Inspektør', 'Inspektør'],
  ['inspectorBackup', 'Inspektør Back-up', 'Inspektør back-up'],
  ['inspectorBackup2', 'Inspektør Back-up 2', 'Inspektør back-up 2'],
  ['assistant', 'Ejendomsassistent', 'Ejendomsassistent'],
  ['assistantBackup', 'Ejendomsassistent Back-up', 'Ejendomsassistent back-up'],
  ['fireInspector', 'Brand og Sikrings Inspektør', 'Brand- og sikringsinspektør'],
  ['kam', 'KAM', 'KAM'],
  ['assetManager', 'Asset Manager', 'Asset Manager'],
  ['assetManagerEmail', 'Asset Manager Email', 'Asset Manager e-mail'],
  ['owner', 'Ejer', 'Ejer'],
  ['cvr', 'CVR', 'CVR'],
  ['coAddress', 'CO Adresse', 'C/O-adresse'],
  ['billingAddress', 'Faktureringsadresse', 'Faktureringsadresse'],
  ['ean', 'EAN-Nummer', 'EAN'],
  ['bookkeeperEmail', 'Email Bogholder', 'Bogholderi e-mail'],
  ['endDateEd', 'Slutdato ED', 'Slutdato ED'],
  ['endDateEs', 'Slutdato ES', 'Slutdato ES'],
  ['remarks', 'Bemærkninger', 'Bemærkninger'],
  ['customer', 'Kunde1', 'Kunde'],
  ['customerCvr', 'Kundes: CVR. Nr.', 'Kundens CVR'],
  ['customerAddress', 'Kundes: Adresse', 'Kundens adresse'],
  ['customerZip', 'Kundes: PostNr', 'Kundens postnr.'],
  ['customerCity', 'Kundes: By', 'Kundens by'],
  ['createdAt', 'Oprettet', 'Oprettet'],
];

const normalizeHeader = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[åæø]/gi, (letter) => ({ å: 'a', æ: 'ae', ø: 'o' }[letter.toLowerCase()]))
  .replace(/[^a-z0-9]+/gi, '')
  .toLowerCase();

const DATE_FIELDS = new Set(['endDateEd', 'endDateEs', 'createdAt']);
// The customer's own details (Fokus Nordic's CVR, address, EAN, bookkeeping mail) are the same on every row,
// so searching them would match everything; they are kept on the property but left out of search.
const UNSEARCHED_FIELDS = new Set(['customer', 'customerCvr', 'customerAddress', 'customerZip', 'customerCity', 'billingAddress', 'coAddress', 'ean', 'bookkeeperEmail']);
const NUMBER_TEXT_FIELDS = new Set(['zipCode', 'cvr', 'ean', 'customerCvr', 'customerZip', 'debtorNumber']);

function cleanValue(field, value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  let text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // SharePoint exports numbers as "2100.00000000000"; show them as written in the source system.
  if (NUMBER_TEXT_FIELDS.has(field) && /^\d+(\.0+)?$/.test(text)) text = text.replace(/\.0+$/, '');
  if (field === 'workAreas') text = text.split(';#').map((part) => part.trim()).filter(Boolean).join(', ');
  if (field === 'status') text = text.toUpperCase();
  return text;
}

// One register row -> a property with every known field plus the label/value pairs used for search.
function normalizeRegisterRow(row) {
  const byHeader = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  const property = {};
  for (const [field, header] of FIELDS) property[field] = cleanValue(field, byHeader.get(normalizeHeader(header)));
  property.number = property.number || cleanValue('number', byHeader.get('ejendomsnr'));
  property.searchFields = FIELDS
    .filter(([field]) => property[field] && !DATE_FIELDS.has(field) && !UNSEARCHED_FIELDS.has(field))
    .map(([field, , label]) => [label, property[field]]);
  return property;
}

function parsePropertyRegister(buffer, { customer = 'Fokus Nordic' } = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]).map(normalizeHeader);
  if (!headers.includes('kunde1') || !headers.includes('ejendomnavn')) {
    throw new Error('Ejendomsudtrækket mangler kolonnerne "Kunde1" og "EjendomNavn".');
  }
  return selectCustomerProperties(rows, customer);
}

// Shared by the Excel export and the SharePoint list: normalize rows, keep one customer, active first.
function selectCustomerProperties(rows, customer = 'Fokus Nordic') {
  const wanted = String(customer).trim().toLocaleLowerCase('da');
  return rows
    .map(normalizeRegisterRow)
    .filter((property) => String(property.customer || '').toLocaleLowerCase('da') === wanted && (property.name || property.number))
    .sort((a, b) => (a.status === 'AKTIV' ? 0 : 1) - (b.status === 'AKTIV' ? 0 : 1) || String(a.name).localeCompare(String(b.name), 'da'));
}

// Re-reads the export when the file changes. A SharePoint list source can replace this once Graph access is granted.
function createPropertyRegisterService({ sourcePath = null, customer = 'Fokus Nordic', fsImpl = fs } = {}) {
  let cache = null;
  return {
    source: 'excel',
    get configured() {
      return Boolean(sourcePath);
    },
    async getProperties() {
      if (!sourcePath) throw new Error('Ejendomsudtrækket er ikke konfigureret. Angiv PROPERTY_REGISTER_PATH i .env, og genstart appen.');
      let stat;
      try {
        stat = fsImpl.statSync(sourcePath);
      } catch {
        throw new Error(`Ejendomsudtrækket blev ikke fundet: ${sourcePath}`);
      }
      const version = `${stat.mtimeMs}:${stat.size}`;
      if (!cache || cache.version !== version) {
        cache = { version, properties: parsePropertyRegister(fsImpl.readFileSync(sourcePath), { customer }), modifiedAt: stat.mtime.toISOString(), source: 'excel', warning: null };
      }
      return cache;
    },
  };
}

// Reads the same register from the SharePoint list "Ejendomsoversigt". The list is fetched at most every
// cacheTtlMs; a stale copy is served while a refresh runs, and kept (with a warning) if a refresh fails.
function createSharePointPropertyRegister({ listClient, customer = 'Fokus Nordic', cacheTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let cache = null;
  let refreshing = null;
  let lastError = null;
  const load = async () => {
    const { rows, listModifiedAt } = await listClient.getRows();
    if (!rows.length) throw new Error('SharePoint-listen returnerede ingen rækker.');
    return { properties: selectCustomerProperties(rows, customer), modifiedAt: listModifiedAt || new Date(now()).toISOString(), fetchedAt: now(), totalRows: rows.length };
  };
  const snapshot = () => ({ ...cache, source: 'sharepoint', warning: lastError ? `Seneste hentning fra SharePoint fejlede (${lastError}); viser data hentet ${new Date(cache.fetchedAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}.` : null });
  return {
    source: 'sharepoint',
    configured: Boolean(listClient),
    async getProperties() {
      if (!listClient) throw new Error('SharePoint-listen er ikke konfigureret.');
      if (cache && now() - cache.fetchedAt < cacheTtlMs) return snapshot();
      if (!refreshing) {
        refreshing = load()
          .then((result) => { cache = result; lastError = null; })
          .catch((error) => { lastError = error.message; throw error; })
          .finally(() => { refreshing = null; });
      }
      if (cache) {
        refreshing.catch(() => {});
        return snapshot();
      }
      await refreshing;
      return snapshot();
    },
  };
}

module.exports = { createPropertyRegisterService, createSharePointPropertyRegister, parsePropertyRegister, selectCustomerProperties, normalizeRegisterRow, FIELDS };
