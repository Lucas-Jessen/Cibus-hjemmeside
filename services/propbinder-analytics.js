const CLOSED_STATUS = /afsluttet|lukket|færdig|fuldført|udført|aflyst|annulleret|completed|closed|done|cancel/i;

const isClosed = (task) => CLOSED_STATUS.test(task.status || '');

// Unmapped Propbinder status ids are kept apart by a short id, so the distribution is useful before names are configured.
const statusLabel = (task) => (task.status && task.status !== 'Ukendt') ? task.status : (task.statusId ? `Ukendt (${task.statusId.slice(0, 8)})` : 'Ukendt');

// Groups titles that only differ by case, spacing or trailing punctuation.
const titleKey = (title) => String(title || '').toLocaleLowerCase('da').replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/, '').trim();

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

const top = (counts, limit) => [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'da')).slice(0, limit);

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthStart = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
const dayKey = (date) => `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;

const shiftMonth = (key, delta) => monthKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1));

// "Oprettede opgaver" chart. One month (default: the current one) is shown per day; a year ('seneste' = the last
// 12 months, or a calendar year 'YYYY') or an interval from one month to another is shown per month.
// `months` and `years` list what the pickers offer, from the first task up to now.
function buildCreationChart(tasks, { month = null, from = null, to = null, year = null, now = new Date(), maxMonths = 36 } = {}) {
  const created = tasks.map((task) => (task.createdAt ? new Date(task.createdAt) : null)).filter((date) => date && !Number.isNaN(date.getTime()));
  const current = monthKey(now);
  const first = created.length ? monthKey(new Date(Math.min(...created))) : current;
  const months = [];
  for (let date = monthStart(first < current ? first : current); monthKey(date) <= current; date = new Date(date.getFullYear(), date.getMonth() + 1, 1)) months.push(monthKey(date));
  const years = [...new Set(months.map((key) => key.slice(0, 4)))].reverse();
  const label = (key) => monthStart(key).toLocaleDateString('da-DK', { month: 'long', year: 'numeric' });

  // A year is an interval: the last 12 months, or January–December of a calendar year (up to the current month).
  let yearKey = null;
  if (year === 'seneste') {
    [from, to, yearKey] = [shiftMonth(current, -11), current, 'seneste'];
  } else if (/^\d{4}$/.test(year || '') && years.includes(year)) {
    [from, to, yearKey] = [`${year}-01`, `${year}-12` < current ? `${year}-12` : current, year];
  }

  if (MONTH_PATTERN.test(from || '') && MONTH_PATTERN.test(to || '')) {
    let [start, end] = from <= to ? [from, to] : [to, from];
    const span = [];
    for (let date = monthStart(start); monthKey(date) <= end; date = new Date(date.getFullYear(), date.getMonth() + 1, 1)) span.push(monthKey(date));
    // Keep the chart readable: at most maxMonths columns, counted back from the end of the interval.
    const keys = span.slice(-maxMonths);
    start = keys[0];
    const counts = new Map(keys.map((key) => [key, 0]));
    for (const date of created) { const key = monthKey(date); if (counts.has(key)) counts.set(key, counts.get(key) + 1); }
    const columns = keys.map((key, index) => ({
      key, filter: { maaned: key }, count: counts.get(key),
      label: monthStart(key).toLocaleDateString('da-DK', { month: 'short' }).replace('.', ''),
      sub: index === 0 || key.endsWith('-01') ? key.slice(0, 4) : '',
      title: label(key),
    }));
    const title = yearKey === 'seneste' ? `Seneste 12 måneder (${label(start)} – ${label(end)})` : yearKey ? `Hele ${yearKey}` : `${label(start)} – ${label(end)}`;
    return { mode: yearKey ? 'year' : 'interval', year: yearKey, from: start, to: end, title, columns, total: columns.reduce((sum, column) => sum + column.count, 0), months, years, current, truncated: span.length > keys.length };
  }

  const key = MONTH_PATTERN.test(month || '') ? month : current;
  const startDate = monthStart(key);
  const days = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  const counts = new Map();
  for (const date of created) if (monthKey(date) === key) counts.set(date.getDate(), (counts.get(date.getDate()) || 0) + 1);
  const columns = [];
  for (let day = 1; day <= days; day++) {
    const date = new Date(startDate.getFullYear(), startDate.getMonth(), day);
    columns.push({
      key: dayKey(date), filter: { dag: dayKey(date) }, count: counts.get(day) || 0,
      label: String(day), sub: date.getDay() === 1 ? 'man' : '',
      title: date.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      future: date > now,
    });
  }
  return { mode: 'month', month: key, title: label(key), columns, total: columns.reduce((sum, column) => sum + column.count, 0), months, years, current };
}

function buildTaskAnalytics(tasks, { now = new Date(), months = 12, limit = 10 } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const open = tasks.filter((task) => !isClosed(task));

  const statuses = top(countBy(tasks, statusLabel), 12).map(([label, count]) => ({ label, count }));

  const titleGroups = new Map();
  for (const task of tasks) {
    // Cases have no title from the API (only "Sag fra …"), so they would always look like repeats.
    const key = task.kind === 'Sag' ? null : titleKey(task.title);
    if (!key) continue;
    const group = titleGroups.get(key) || { title: task.title, count: 0, properties: new Set() };
    group.count += 1;
    if (task.property) group.properties.add(task.property);
    titleGroups.set(key, group);
  }
  const recurring = [...titleGroups.values()].filter((group) => group.count > 1);
  const recurringTitles = recurring.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'da')).slice(0, limit)
    .map((group) => ({ title: group.title, count: group.count, propertyCount: group.properties.size }));

  const propertyNumbers = new Map(tasks.filter((task) => task.property).map((task) => [task.property, task.propertyNumber]));
  const byProperty = top(countBy(tasks, (task) => task.property), limit + 5)
    .map(([property, count]) => ({ property, propertyNumber: propertyNumbers.get(property) || null, count }));

  const byResponsible = top(countBy(tasks, (task) => task.assignedTo), 8).map(([name, count]) => ({ name, count }));

  const monthCounts = countBy(tasks, (task) => (task.createdAt ? monthKey(new Date(task.createdAt)) : null));
  const perMonth = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = monthKey(date);
    perMonth.push({ key, label: date.toLocaleDateString('da-DK', { month: 'short' }).replace('.', ''), year: date.getFullYear(), count: monthCounts.get(key) || 0 });
  }

  return {
    totals: {
      tasks: tasks.length,
      properties: propertyNumbers.size,
      recurringGroups: recurring.length,
      recurringTasks: recurring.reduce((sum, group) => sum + group.count, 0),
      overdue: open.filter((task) => task.dueDate && new Date(task.dueDate) < today).length,
      dueSoon: open.filter((task) => task.dueDate && new Date(task.dueDate) >= today && new Date(task.dueDate) <= in30Days).length,
    },
    statuses,
    recurringTitles,
    byProperty,
    byResponsible,
    perMonth,
  };
}

module.exports = { buildCreationChart, buildTaskAnalytics, statusLabel, titleKey, isClosed };
