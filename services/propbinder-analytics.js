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

function buildTaskAnalytics(tasks, { now = new Date(), months = 12, limit = 10 } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const open = tasks.filter((task) => !isClosed(task));

  const statuses = top(countBy(tasks, statusLabel), 12).map(([label, count]) => ({ label, count }));

  const titleGroups = new Map();
  for (const task of tasks) {
    const key = titleKey(task.title);
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

module.exports = { buildTaskAnalytics, statusLabel, titleKey, isClosed };
