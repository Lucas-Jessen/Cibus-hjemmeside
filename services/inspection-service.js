// Tilsyn: reads the inspection register ("Cibus tilsyn pr <dato>.xlsx", columns Ejendom, Postnummer,
// Seneste Tilsyn, Forrige tilsyn, Bemærkning). `sourcePath` may be a file or a folder; for a folder the newest
// .xlsx is used, so a new monthly file only has to be dropped in. The file is re-read when it changes.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DAY = 24 * 60 * 60 * 1000;
const normalizeHeader = (value) => String(value ?? '').toLocaleLowerCase('da').replace(/[^a-zæøå0-9]/g, '');
const text = (value) => (value == null || String(value).trim() === '' ? null : String(value).replace(/\s+/g, ' ').trim());

// Excel dates arrive as serial numbers; they are dates without a time, so they are kept as UTC midnight.
function toDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)) : null;
  }
  const match = String(value).trim().match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (!match) return null;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  return new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
}

// "Planlagt til 10/11" has no year: it is the first 10 November from two months before today, so a
// visit planned for last week still shows as planned (the sheet is updated monthly).
function plannedDate(remark, now = new Date()) {
  const match = String(remark || '').match(/planlagt\s+(?:til\s+)?(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/i);
  if (!match) return null;
  const base = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 2, now.getDate()));
  let year = match[3] ? (Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])) : base.getUTCFullYear();
  let date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
  if (!match[3] && date < base) date = new Date(Date.UTC(year + 1, Number(match[2]) - 1, Number(match[1])));
  return date;
}

function region(zip) {
  const n = Number(zip);
  if (!n) return 'Ukendt';
  // The five Danish regions, approximated by postcode ranges (close enough for an overview).
  if (n < 3800) return 'Hovedstaden';
  if (n < 5000) return 'Sjælland';
  if (n < 7300) return 'Syddanmark';
  if (n < 9000) return 'Midtjylland';
  return 'Nordjylland';
}

function ownerType(name) {
  if (/^e\s*\/\s*f\b/i.test(name)) return 'Ejerforening';
  if (/^gf\b/i.test(name)) return 'Grundejerforening';
  return 'Ejendom';
}

// Age buckets shown on the dashboard. The thresholds are an assumption for the example (no agreed interval yet).
const AGE_BUCKETS = [
  { key: 'under3', label: 'Under 3 mdr.', maxDays: 92 },
  { key: '3til6', label: '3–6 mdr.', maxDays: 183 },
  { key: '6til12', label: '6–12 mdr.', maxDays: 365 },
  { key: 'over12', label: 'Over 12 mdr.', maxDays: Infinity },
];
const bucketFor = (days) => AGE_BUCKETS.find((bucket) => days <= bucket.maxDays);

function parseInspectionWorkbook(buffer, { now = new Date(), matcher = null } = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, blankrows: false, raw: true });
  const headerIndex = rows.findIndex((row) => row.map(normalizeHeader).includes('ejendom'));
  if (headerIndex < 0) throw new Error('Tilsynsarket mangler kolonnen "Ejendom".');
  const headers = rows[headerIndex].map(normalizeHeader);
  const col = (row, ...names) => { const index = headers.findIndex((header) => names.includes(header)); return index < 0 ? null : row[index]; };
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return rows.slice(headerIndex + 1).map((row) => {
    const name = text(col(row, 'ejendom'));
    if (!name) return null;
    const zip = text(col(row, 'postnummer', 'postnr'));
    const latest = toDate(col(row, 'senestetilsyn'));
    const previous = toDate(col(row, 'forrigetilsyn'));
    const remark = text(col(row, 'bemærkning', 'bemaerkning'));
    const daysSince = latest ? Math.max(0, Math.round((today - latest.getTime()) / DAY)) : null;
    const planned = plannedDate(remark, now);
    const match = matcher ? matcher.match(name, zip) : null;
    const bucket = daysSince == null ? null : bucketFor(daysSince);
    return {
      name,
      zip,
      region: region(zip),
      ownerType: ownerType(name),
      latest: latest && latest.toISOString(),
      previous: previous && previous.toISOString(),
      // The sheet repeats the latest date as "forrige" when only one inspection is registered.
      hasPrevious: Boolean(previous && latest && previous.getTime() !== latest.getTime()),
      intervalDays: previous && latest && previous.getTime() !== latest.getTime() ? Math.round((latest - previous) / DAY) : null,
      daysSince,
      bucket: bucket ? bucket.key : 'ukendt',
      bucketLabel: bucket ? bucket.label : 'Ingen dato',
      remark,
      planned: planned && planned.toISOString(),
      remarkType: planned ? 'Planlagt' : /lejerdel/i.test(remark || '') ? 'Med lejerdelen' : remark ? 'Anden bemærkning' : 'Ingen bemærkning',
      propertyNumber: match ? match.number : null,
      propertyName: match ? match.name : null,
    };
  }).filter(Boolean).sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1) || a.name.localeCompare(b.name, 'da'));
}

function resolveSource(sourcePath, fsImpl) {
  const stat = fsImpl.statSync(sourcePath);
  if (!stat.isDirectory()) return { file: sourcePath, stat };
  const files = fsImpl.readdirSync(sourcePath).filter((name) => /\.xlsx?$/i.test(name) && !name.startsWith('~$'))
    .map((name) => ({ file: path.join(sourcePath, name), stat: fsImpl.statSync(path.join(sourcePath, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!files.length) throw new Error(`Der ligger ingen Excel-fil i ${sourcePath}.`);
  return files[0];
}

function createInspectionService({ sourcePath = null, getMatcher = () => null, fsImpl = fs, now = () => new Date() } = {}) {
  let cache = null;
  return {
    get configured() { return Boolean(sourcePath); },
    getInspections() {
      if (!sourcePath) throw new Error('Tilsynsfilen er ikke konfigureret. Angiv TILSYN_PATH i .env.');
      let source;
      try { source = resolveSource(sourcePath, fsImpl); } catch (error) { throw new Error(error.code === 'ENOENT' ? `Tilsynsfilen blev ikke fundet: ${sourcePath}` : error.message); }
      const matcher = getMatcher();
      const day = now().toISOString().slice(0, 10);
      const version = `${source.file}:${source.stat.mtimeMs}:${source.stat.size}:${day}:${Boolean(matcher)}`;
      if (!cache || cache.version !== version) {
        cache = { version, inspections: parseInspectionWorkbook(fsImpl.readFileSync(source.file), { now: now(), matcher }), modifiedAt: source.stat.mtime.toISOString(), fileName: path.basename(source.file) };
      }
      return cache;
    },
  };
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) { const key = keyOf(item); if (key) counts.set(key, (counts.get(key) || 0) + 1); }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'da'));
}

function buildInspectionAnalytics(inspections, { now = new Date() } = {}) {
  const dated = inspections.filter((item) => item.latest);
  const ages = dated.map((item) => item.daysSince).sort((a, b) => a - b);
  const median = ages.length ? (ages.length % 2 ? ages[(ages.length - 1) / 2] : Math.round((ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2)) : null;
  // Latest inspections per month, the last 12 months up to today.
  const months = [];
  for (let back = 11; back >= 0; back--) {
    const date = new Date(Date.UTC(now.getFullYear(), now.getMonth() - back, 1));
    const key = date.toISOString().slice(0, 7);
    months.push({ key, label: date.toLocaleDateString('da-DK', { month: 'short', timeZone: 'UTC' }).replace('.', ''), year: date.getUTCFullYear(), count: dated.filter((item) => item.latest.slice(0, 7) === key).length });
  }
  const intervals = inspections.filter((item) => item.intervalDays != null).map((item) => item.intervalDays);
  return {
    totals: {
      inspections: inspections.length,
      linked: inspections.filter((item) => item.propertyNumber).length,
      recent: dated.filter((item) => item.daysSince <= 92).length,
      over12: dated.filter((item) => item.daysSince > 365).length,
      planned: inspections.filter((item) => item.planned).length,
      medianDays: median,
      withPrevious: intervals.length,
      averageInterval: intervals.length ? Math.round(intervals.reduce((sum, days) => sum + days, 0) / intervals.length) : null,
    },
    buckets: AGE_BUCKETS.map((bucket) => ({ ...bucket, count: inspections.filter((item) => item.bucket === bucket.key).length })),
    months,
    oldest: dated.slice(0, 10),
    regions: countBy(inspections, (item) => item.region),
    remarkTypes: countBy(inspections, (item) => item.remarkType),
    planned: inspections.filter((item) => item.planned).sort((a, b) => a.planned.localeCompare(b.planned)),
  };
}

module.exports = { createInspectionService, parseInspectionWorkbook, buildInspectionAnalytics, plannedDate, AGE_BUCKETS };
