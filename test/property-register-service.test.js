const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parsePropertyRegister, normalizeRegisterRow, createPropertyRegisterService, createSharePointPropertyRegister } = require('../services/property-register-service');
const { createSharePointListClient } = require('../services/sharepoint-list-client');

const HEADER = ['Id', 'Kundenummer (Debitornummer)', 'EjendomsNr', 'EjendomNavn', 'Adresse', 'Adresse2', 'PostNr', 'By', 'Kundestatus - FSE', 'Arbejdsområder', 'Inspektør', 'EjendomNr', 'Segment', 'CVR', 'Asset Manager', 'Ejer', 'Kunde1', 'Portefølje1', 'Kundes: PostNr', 'Elementtype'];

function workbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'query (31)');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('keeps only Fokus Nordic properties, active first and sorted by name', () => {
  const properties = parsePropertyRegister(workbookBuffer([
    [1, '37670', 'F3062', '8Tallet', 'Richard Mortensens Vej 61-81', null, 2300, 'København S', 'AKTIV', 'Ejendomsdrift;#Vagt', 'Jan', 'F3062', 'Kontor', 38484036, 'Patrick', 'LP P/S', 'Fokus Nordic', 'LP', '2100.00000000000', 'Element'],
    [2, '20890', null, '(AL Finans) Sluseholmen 2', 'Sluseholmen 2', null, 2450, 'København SV', 'OPHØRT', 'Ejendomsdrift', 'Arne', null, null, 31433428, null, null, 'AL Finans A/S', null, null, 'Element'],
    [3, '37644', 'F3050', 'Fiolstræde 20-24', 'Krystalgade 14-16', 'Fiolstræde 20-24', 1171, 'København K', 'ophørt', 'Ejendomsdrift', 'Steen', 'F3050', 'Bolig', 35047654, 'Patrick', 'LP Bolig A/S', ' fokus nordic ', 'LP', null, 'Element'],
    [4, '37649', 'F2020', 'Amerikavej 15', 'Rejsbygade 8', null, 1756, 'København V', 'AKTIV', 'Ejendomsdrift', 'Søren', 'F2020', 'Ejerforening', 33429339, 'Patrick', 'E/F', 'Fokus Nordic', 'E/F Amerikavej 15', null, 'Element'],
  ]));

  assert.deepEqual(properties.map((property) => [property.number, property.status]), [['F3062', 'AKTIV'], ['F2020', 'AKTIV'], ['F3050', 'OPHØRT']]);
  const [first] = properties;
  assert.equal(first.workAreas, 'Ejendomsdrift, Vagt');
  assert.equal(first.customerZip, '2100');
  assert.equal(first.cvr, '38484036');
  assert.equal(first.zipCode, '2300');
  assert.equal(first.debtorNumber, '37670');
});

test('collects labelled search fields from every filled column', () => {
  const property = normalizeRegisterRow({ EjendomNr: 'F1', EjendomNavn: 'Købmagergade 1', By: 'København K', 'Inspektør': 'Jan', CVR: 123, Kunde1: 'Fokus Nordic', Oprettet: new Date('2024-01-01') });

  assert.deepEqual(property.searchFields, [['Ejendomsnr.', 'F1'], ['Ejendomsnavn', 'Købmagergade 1'], ['By', 'København K'], ['Inspektør', 'Jan'], ['CVR', '123']]);
});

test('fails clearly without the customer column and reports a missing file', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Navn'], ['X']]), 'Ark');
  assert.throws(() => parsePropertyRegister(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })), /Kunde1/);
  const service = createPropertyRegisterService({ sourcePath: 'mangler.xlsx', fsImpl: { statSync: () => { throw new Error('ENOENT'); } } });
  await assert.rejects(service.getProperties(), /ikke fundet/);
  assert.equal(createPropertyRegisterService().configured, false);
});

function fakeGraph() {
  const calls = [];
  const routes = {
    '/sites/contoso.sharepoint.com:/sites/Drift': { id: 'site-1' },
    '/sites/site-1/lists': { value: [{ id: 'list-1', displayName: 'Ejendomsoversigt' }] },
    '/sites/site-1/lists/list-1/columns': { value: [
      { name: 'Title', displayName: 'EjendomsNr' },
      { name: 'field_2', displayName: 'EjendomNavn' },
      { name: 'Kundestatus_x0020__x002d__x0020_', displayName: 'Kundestatus - FSE' },
      { name: 'Inspekt_x00f8_r', displayName: 'Inspektør' },
      { name: 'Arbejdsomr_x00e5_der', displayName: 'Arbejdsområder' },
      { name: 'Kunde1', displayName: 'Kunde1' },
      { name: 'EjendomNr', displayName: 'EjendomNr' },
      { name: 'Hemmelig', displayName: 'Inspektør', hidden: true },
      { name: 'Andet', displayName: 'Ikke brugt' },
    ] },
    '/sites/site-1/lists/list-1/items': { value: [{ fields: { Title: 'F1', EjendomNr: 'F1', field_2: '8Tallet', Kundestatus_x0020__x002d__x0020_: 'AKTIV', Inspekt_x00f8_r: 'Jan', Arbejdsomr_x00e5_der: ['Ejendomsdrift', 'Vagt'], Kunde1: 'Fokus Nordic' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site-1/lists/list-1/items?page=2' },
    '/sites/site-1/lists/list-1/items?page=2': { value: [{ fields: { Title: 'X9', EjendomNr: 'X9', field_2: 'Anden', Kunde1: 'Anden kunde' } }] },
    '/sites/site-1/lists/list-1': { lastModifiedDateTime: '2026-10-28T08:00:00Z' },
  };
  const fetchImpl = async (url) => {
    const path = url.replace('https://graph.microsoft.com/v1.0', '');
    calls.push(path);
    const key = path.includes('?page=2') ? path : path.split('?')[0];
    const body = routes[key];
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body || { error: { code: 'itemNotFound' } } };
  };
  return { calls, fetchImpl };
}

test('reads the SharePoint list by display names, follows paging and selects person columns explicitly', async () => {
  const graph = fakeGraph();
  const client = createSharePointListClient({ tenantId: 't', clientId: 'c', clientSecret: 's', site: 'contoso.sharepoint.com:/sites/Drift', listName: 'Ejendomsoversigt', columns: ['EjendomsNr', 'EjendomNavn', 'Kundestatus - FSE', 'Inspektør', 'Arbejdsområder', 'Kunde1', 'EjendomNr'], fetchImpl: graph.fetchImpl, credential: { getToken: async () => ({ token: 'x' }) } });

  const { rows, listModifiedAt } = await client.getRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { EjendomsNr: 'F1', EjendomNavn: '8Tallet', 'Kundestatus - FSE': 'AKTIV', Inspektør: 'Jan', Arbejdsområder: 'Ejendomsdrift, Vagt', Kunde1: 'Fokus Nordic', EjendomNr: 'F1' });
  assert.equal(listModifiedAt, '2026-10-28T08:00:00Z');
  const itemsCall = graph.calls.find((call) => call.includes('/items?$expand'));
  assert.match(itemsCall, /Inspekt_x00f8_r/);
  assert.doesNotMatch(itemsCall, /Hemmelig|Andet/);
});

test('SharePoint register keeps one customer and serves the last data with a warning when a refresh fails', async () => {
  let clock = 0;
  let fail = false;
  const listClient = { getRows: async () => {
    if (fail) throw new Error('SharePoint svarede 503');
    return { rows: [{ EjendomNr: 'F1', EjendomNavn: '8Tallet', 'Kundestatus - FSE': 'AKTIV', Kunde1: 'Fokus Nordic' }, { EjendomNr: 'X9', EjendomNavn: 'Anden', Kunde1: 'Anden kunde' }], listModifiedAt: '2026-10-28T08:00:00Z' };
  } };
  const register = createSharePointPropertyRegister({ listClient, cacheTtlMs: 1000, now: () => clock });

  let result = await register.getProperties();
  assert.deepEqual(result.properties.map((p) => p.number), ['F1']);
  assert.equal(result.source, 'sharepoint');
  assert.equal(result.warning, null);
  clock = 2000;
  fail = true;
  await register.getProperties();
  await new Promise((resolve) => setImmediate(resolve));
  result = await register.getProperties();
  assert.deepEqual(result.properties.map((p) => p.number), ['F1']);
  assert.match(result.warning, /Seneste hentning fra SharePoint fejlede \(SharePoint svarede 503\)/);
});

test('asks SharePoint to return only rows for one customer', async () => {
  const requests = [];
  const graph = fakeGraph();
  const fetchImpl = async (url, options) => { requests.push({ url, prefer: options.headers.Prefer }); return graph.fetchImpl(url, options); };
  const client = createSharePointListClient({ tenantId: 't', clientId: 'c', clientSecret: 's', site: 'contoso.sharepoint.com:/sites/Drift', listName: 'Ejendomsoversigt', columns: ['EjendomNr', 'EjendomNavn'], where: { column: 'Kunde1', equals: "Fokus Nordic's" }, fetchImpl, credential: { getToken: async () => ({ token: 'x' }) } });

  await client.getRows();
  const itemsRequest = requests.find((request) => request.url.includes('/items?$expand'));
  assert.match(decodeURIComponent(itemsRequest.url), /\$filter=fields\/Kunde1 eq 'Fokus Nordic''s'/);
  assert.equal(itemsRequest.prefer, 'HonorNonIndexedQueriesWarningMayFailRandomly');
  assert.match(itemsRequest.url, /Kunde1/);
});
