const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { createPropertyMatcher } = require('../services/cibus-property-matcher');
const { parseInspectionWorkbook, buildInspectionAnalytics, plannedDate } = require('../services/inspection-service');
const { parseSchema, parseLocation, normalizeRow, buildReportAnalytics } = require('../services/report-service');

const properties = [
  { number: 'F4354', name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', zipCode: '2960' },
  { number: 'F4352', name: 'Prøvestenscenteret', address: 'Birkedalsvej 2-16', zipCode: '3000' },
  { number: 'F4370', name: 'Gl. Ålborgvej 21', address: 'Gl. Ålborgvej 21', zipCode: '8800' },
  { number: 'F4356', name: 'Grindsted Center', address: 'Vestergade 32-34', zipCode: '7200' },
  { number: 'F4479', name: 'Vestre Boulevard 3, Grindsted', address: 'Vestre Boulevard 3', zipCode: '7200' },
  { number: 'F4376', name: 'Halgårdvej 1', address: 'Halgård Skolevej 1', zipCode: '7500' },
];

test('matcher links names, addresses and E/F rows to Cibus property numbers', () => {
  const matcher = createPropertyMatcher(properties);
  assert.equal(matcher.match('E/F Rungsted Bytorv', '2960').number, 'F4354');
  assert.equal(matcher.match('Birkedalsvej 2-16').number, 'F4352');
  assert.equal(matcher.match('Gl. Ålborgvej 21', '8800').number, 'F4370');
  assert.equal(matcher.match('Grindsted Center', '7200').number, 'F4356');
  assert.equal(matcher.match('Halgårdvej 1', '7500').number, 'F4376');
  assert.equal(matcher.match('Pure Gym'), null);
});

test('planned dates without a year fall in the coming months', () => {
  const now = new Date(Date.UTC(2026, 10, 5));
  assert.equal(plannedDate('Planlagt til 6/11', now).toISOString().slice(0, 10), '2026-11-06');
  assert.equal(plannedDate('Planlagt til 10/1', now).toISOString().slice(0, 10), '2027-01-10');
  assert.equal(plannedDate('Tages sammen med lejerdelen', now), null);
});

test('inspection sheet is parsed with age buckets, intervals and property links', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Regisetering af tilsyn med ejendomme '],
    ['Ejendom', 'Postnummer', 'Seneste Tilsyn ', 'Forrige tilsyn', 'Bemærkning'],
    ['Rungsted Bytorv', 2960, 46324, 46216, null],
    ['Gl. Ålborgvej 21', 8800, 45939, 45939, 'Planlagt til 6/11'],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Ark1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const rows = parseInspectionWorkbook(buffer, { now: new Date(2026, 10, 5), matcher: createPropertyMatcher(properties) });
  assert.equal(rows.length, 2);
  const [oldest, recent] = rows;
  assert.equal(oldest.name, 'Gl. Ålborgvej 21');
  assert.equal(oldest.bucket, 'over12');
  assert.equal(oldest.hasPrevious, false);
  assert.equal(oldest.planned.slice(0, 10), '2026-11-06');
  assert.equal(recent.propertyNumber, 'F4354');
  assert.equal(recent.intervalDays, 108);
  assert.equal(recent.region, 'Hovedstaden');
  const analytics = buildInspectionAnalytics(rows, { now: new Date(2026, 10, 5) });
  assert.equal(analytics.totals.over12, 1);
  assert.equal(analytics.totals.planned, 1);
});

test('report schema and location are split into category, frequency, place and tenant', () => {
  assert.deepEqual(parseSchema('BR18 - Flugtvejs- & panikbelysning (Måned) 7.5.5.1'), { category: 'Flugtvejs- & panikbelysning', frequency: 'Måned', paragraph: '7.5.5.1', kind: 'BR18-kontrol' });
  assert.equal(parseSchema('Lejers Egenkontrol').kind, 'Lejers egenkontrol');
  assert.equal(parseSchema('Håndildslukkere (Årlig)').kind, 'Øvrigt eftersyn');
  const location = parseLocation('Inaktive kunder / ... / Rungsted Bytorv 1-7 / Meny - (Egenkontrol) / Lejers Egenkontrol');
  assert.equal(location.place, 'Rungsted Bytorv 1-7');
  assert.equal(location.area, 'Meny');
});

test('report rows become records and analytics count deviations separately', () => {
  const matcher = createPropertyMatcher(properties);
  const row = (section, date) => ({ section, cells: { Dato: [date, '11:34'], Skema: ['BR18 - AVS anlæg (Uge) 7.5.2.1'], Lokation: ['Inaktive kunder / ... / Rungsted Bytorv 1-7 / P-Kælder / AVS', 'anlæg'], Bruger: ['Christian', 'Lunding'] } });
  const report = normalizeRow(row('rapporter', '27.10.2026'), { matcher });
  assert.equal(report.date, '2026-10-27');
  assert.equal(report.week, 'Uge 44');
  assert.equal(report.object, 'AVS anlæg');
  assert.equal(report.user, 'Christian Lunding');
  assert.equal(report.propertyNumber, 'F4354');
  const analytics = buildReportAnalytics({ reports: [report], deviations: [normalizeRow(row('afvigelser', '28.10.2026'), { matcher })] });
  assert.equal(analytics.totals.reports, 1);
  assert.equal(analytics.totals.deviations, 1);
  assert.equal(analytics.categories[0].label, 'AVS anlæg');
});
