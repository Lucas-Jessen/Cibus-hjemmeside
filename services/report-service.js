// Rapporter og afvigelser: reads the monthly PDF export ("Rapporter og afvigelser CIBUS <måned>.pdf").
// Every PDF in `sourcePath` (a folder or one file) is read, so months add up as files are dropped in.
// The PDF is a table (Dato, Skema, Lokation, Bruger) whose cells wrap over several lines; text is placed in
// columns by its x position under the header, and a row runs from one date to the next. A section heading
// ("Rapporter" / "Afvigelser") decides which list a row belongs to.
const fs = require('fs');
const path = require('path');

const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

const fold = (value) => String(value || '').toLocaleLowerCase('da').replace(/[^a-zæøå]/g, '');
const SECTION_HEADINGS = { rapporter: 'rapporter', afvigelser: 'afvigelser' };
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

async function extractRows(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0, standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep }).promise;
  const rows = [];
  let section = 'rapporter';
  let columns = null;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const items = (await page.getTextContent()).items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    // Header row(s) on this page: the line with "Dato".
    const headerItems = [];
    for (const item of items) {
      if (SECTION_HEADINGS[fold(item.text)] && !headerItems.length) section = SECTION_HEADINGS[fold(item.text)];
      if (fold(item.text) === 'dato') {
        const line = items.filter((other) => Math.abs(other.y - item.y) < 2);
        headerItems.push({ y: item.y, columns: line.sort((a, b) => a.x - b.x).map((other) => ({ label: other.text, x: other.x })), section });
      }
      // A heading lower on the page switches section for the rows after it.
      if (SECTION_HEADINGS[fold(item.text)] && headerItems.length) headerItems.push({ y: item.y, switchTo: SECTION_HEADINGS[fold(item.text)] });
    }
    const dateColumnX = () => columns && columns.find((column) => fold(column.label) === 'dato').x;
    const starts = [];
    for (const item of items) {
      const marker = headerItems.filter((header) => header.y >= item.y - 0.5).at(-1);
      if (marker && marker.columns) { columns = marker.columns; section = marker.section; }
      if (marker && marker.switchTo) section = marker.switchTo;
      if (!columns || (marker && Math.abs(marker.y - item.y) < 2)) continue;
      if (DATE_RE.test(item.text) && Math.abs(item.x - dateColumnX()) < 6) starts.push({ y: item.y, section, columns });
    }
    starts.forEach((start, index) => {
      const nextY = index + 1 < starts.length ? starts[index + 1].y : -Infinity;
      const cells = Object.fromEntries(start.columns.map((column) => [column.label, []]));
      for (const item of items) {
        if (item.y > start.y + 2 || item.y <= nextY + 2) continue;
        if (SECTION_HEADINGS[fold(item.text)] || headerItems.some((header) => header.columns && Math.abs(header.y - item.y) < 2)) continue;
        const column = [...start.columns].reverse().find((candidate) => item.x >= candidate.x - 3);
        if (column) cells[column.label].push(item.text);
      }
      rows.push({ section: start.section, page: pageNumber, cells: Object.fromEntries(Object.entries(cells).map(([label, parts]) => [label, parts])) });
    });
  }
  return rows;
}

const joinLines = (parts) => (parts || []).join(' ').replace(/\s+/g, ' ').replace(/\s+\/\s*/g, ' / ').trim();
const cell = (cells, name) => { const key = Object.keys(cells).find((label) => fold(label) === fold(name)); return key ? cells[key] : []; };

// "BR18 - Flugtvejs- & panikbelysning (Måned) 7.5.5.1" -> category, frequency, BR18 paragraph and kind.
function parseSchema(schema) {
  const frequency = (schema.match(/\((Uge|Måned|Kvartal|Halvår|Årlig|År)\)/i) || [])[1] || null;
  const paragraph = (schema.match(/(\d+(?:\.\d+){2,})\s*$/) || [])[1] || null;
  const isBr18 = /^BR\s*18\b/i.test(schema);
  let category = schema.replace(/^BR\s*18\s*-\s*/i, '').replace(/\([^)]*\)/g, '').replace(/\d+(?:\.\d+){2,}\s*$/, '').replace(/\s+/g, ' ').trim();
  if (/egenkontrol/i.test(category)) category = 'Lejers egenkontrol';
  category = category.charAt(0).toUpperCase() + category.slice(1);
  const kind = /egenkontrol/i.test(schema) ? 'Lejers egenkontrol' : isBr18 ? 'BR18-kontrol' : 'Øvrigt eftersyn';
  return { category, frequency: frequency ? frequency.charAt(0).toUpperCase() + frequency.slice(1).toLowerCase() : 'Ikke angivet', paragraph, kind };
}

// "Inaktive kunder / ... / Rungsted Bytorv 1-7 / Meny - (Egenkontrol) / Lejers Egenkontrol"
function parseLocation(location) {
  const segments = location.split(' / ').map((part) => part.trim()).filter((part) => part && part !== '...' && !/^inaktive kunder$/i.test(part) && !/^cibus$/i.test(part));
  const clean = (value) => (value || '').replace(/\s*-?\s*\(egenkontrol\)\s*/i, '').replace(/\s*-\s*$/, '').trim() || null;
  return { place: segments[0] || null, area: clean(segments.slice(1, -1).join(' / ')), object: clean(segments.length > 1 ? segments.at(-1) : null), path: segments.join(' / ') };
}

function normalizeRow(row, { matcher = null, sourceFile = null } = {}) {
  const dateParts = cell(row.cells, 'dato');
  const [, day, month, year] = (dateParts[0] || '').match(DATE_RE) || [];
  const time = (dateParts.find((part) => /^\d{1,2}:\d{2}$/.test(part)) || '').padStart(5, '0');
  const schema = joinLines(cell(row.cells, 'skema'));
  const location = joinLines(cell(row.cells, 'lokation'));
  const loc = parseLocation(location);
  const match = matcher && loc.place ? matcher.match(loc.place) : null;
  const iso = day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : null;
  const extra = Object.fromEntries(Object.entries(row.cells).filter(([label]) => !['dato', 'skema', 'lokation', 'bruger'].includes(fold(label))).map(([label, parts]) => [label, joinLines(parts)]));
  return {
    section: row.section,
    date: iso,
    week: iso ? `Uge ${isoWeek(iso)}` : null,
    time: time !== '000' && time ? time : null,
    schema,
    ...parseSchema(schema),
    location,
    place: loc.place,
    area: loc.area,
    object: loc.object,
    user: joinLines(cell(row.cells, 'bruger')) || null,
    propertyNumber: match ? match.number : null,
    propertyName: match ? match.name : null,
    property: match ? match.name : `${loc.place || 'Ukendt'} (ikke koblet)`,
    extra,
    sourceFile,
  };
}

function createReportService({ sourcePath = null, getMatcher = () => null, fsImpl = fs } = {}) {
  let cache = null;
  let loading = null;
  const listFiles = () => {
    const stat = fsImpl.statSync(sourcePath);
    const files = stat.isDirectory()
      ? fsImpl.readdirSync(sourcePath).filter((name) => /\.pdf$/i.test(name)).map((name) => path.join(sourcePath, name))
      : [sourcePath];
    if (!files.length) throw new Error(`Der ligger ingen PDF-filer i ${sourcePath}.`);
    return files.map((file) => ({ file, stat: fsImpl.statSync(file) })).sort((a, b) => a.file.localeCompare(b.file));
  };
  return {
    get configured() { return Boolean(sourcePath); },
    async getReports() {
      if (!sourcePath) throw new Error('Rapportmappen er ikke konfigureret. Angiv RAPPORTER_PATH i .env.');
      let files;
      try { files = listFiles(); } catch (error) { throw new Error(error.code === 'ENOENT' ? `Rapportmappen blev ikke fundet: ${sourcePath}` : error.message); }
      const matcher = getMatcher();
      const version = files.map(({ file, stat }) => `${file}:${stat.mtimeMs}:${stat.size}`).join('|') + `|${Boolean(matcher)}`;
      if (cache && cache.version === version) return cache;
      if (!loading) {
        loading = (async () => {
          const records = [];
          for (const { file } of files) {
            const rows = await extractRows(fsImpl.readFileSync(file));
            records.push(...rows.map((row) => normalizeRow(row, { matcher, sourceFile: path.basename(file) })));
          }
          records.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
          cache = {
            version,
            reports: records.filter((record) => record.section === 'rapporter'),
            deviations: records.filter((record) => record.section === 'afvigelser'),
            files: files.map(({ file, stat }) => ({ name: path.basename(file), modifiedAt: stat.mtime.toISOString() })),
            modifiedAt: new Date(Math.max(...files.map(({ stat }) => stat.mtimeMs))).toISOString(),
          };
          return cache;
        })().finally(() => { loading = null; });
      }
      return loading;
    },
  };
}

function countBy(items, keyOf, extra = () => ({})) {
  const groups = new Map();
  for (const item of items) { const key = keyOf(item); if (!key) continue; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return [...groups.entries()].map(([label, group]) => ({ label, count: group.length, ...extra(group) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'da'));
}

// ISO week number, used to group the month's reports per week.
function isoWeek(iso) {
  const date = new Date(iso + 'T00:00:00Z');
  const dayNumber = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

function buildReportAnalytics({ reports, deviations }) {
  const dates = reports.map((report) => report.date).filter(Boolean).sort();
  const weeks = countBy(reports, (report) => report.week, (group) => ({ places: [...new Set(group.map((report) => report.propertyName || report.place))] }))
    .sort((a, b) => Number(a.label.slice(4)) - Number(b.label.slice(4)));
  return {
    totals: {
      reports: reports.length,
      deviations: deviations.length,
      properties: new Set(reports.map((report) => report.property)).size,
      linked: reports.filter((report) => report.propertyNumber).length,
      users: new Set(reports.map((report) => report.user).filter(Boolean)).size,
      categories: new Set(reports.map((report) => report.category)).size,
      tenantChecks: reports.filter((report) => report.kind === 'Lejers egenkontrol').length,
      br18: reports.filter((report) => report.kind === 'BR18-kontrol').length,
      firstDate: dates[0] || null,
      lastDate: dates.at(-1) || null,
      activeDays: new Set(dates).size,
    },
    kinds: countBy(reports, (report) => report.kind),
    categories: countBy(reports, (report) => report.category, (group) => ({ properties: new Set(group.map((report) => report.property)).size })),
    properties: countBy(reports, (report) => report.property, (group) => ({ number: group[0].propertyNumber, kinds: countBy(group, (report) => report.kind) })),
    users: countBy(reports, (report) => report.user, (group) => ({ properties: new Set(group.map((report) => report.property)).size })),
    frequencies: countBy(reports, (report) => report.frequency),
    weeks,
    tenants: countBy(reports.filter((report) => report.kind === 'Lejers egenkontrol'), (report) => report.area ? `${report.area} · ${report.propertyName || report.place}` : null).slice(0, 10),
  };
}

module.exports = { createReportService, buildReportAnalytics, extractRows, normalizeRow, parseSchema, parseLocation };
