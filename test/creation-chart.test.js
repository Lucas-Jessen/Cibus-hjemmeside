const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCreationChart } = require('../services/propbinder-analytics');

const now = new Date(2026, 10, 9, 12); // 9. november 2026
const tasks = [
  { createdAt: '2026-11-04T08:00:00' }, { createdAt: '2026-11-04T09:00:00' }, { createdAt: '2026-11-06T05:27:00' },
  { createdAt: '2026-10-13T09:00:00' }, { createdAt: '2026-09-01T10:00:00' }, { createdAt: '2025-12-24T10:00:00' },
  { createdAt: null },
];

test('default is the current month, one column per day', () => {
  const chart = buildCreationChart(tasks, { now });
  assert.equal(chart.mode, 'month');
  assert.equal(chart.month, '2026-11');
  assert.equal(chart.columns.length, 30);
  assert.equal(chart.total, 3);
  assert.equal(chart.columns[3].count, 2);
  assert.deepEqual(chart.columns[3].filter, { dag: '2026-11-04' });
  assert.equal(chart.columns[20].future, true);
  assert.equal(chart.months[0], '2025-12');
  assert.equal(chart.months.at(-1), '2026-11');
});

test('a chosen month is shown per day; an invalid one falls back to the current month', () => {
  assert.equal(buildCreationChart(tasks, { now, month: '2026-10' }).total, 1);
  assert.equal(buildCreationChart(tasks, { now, month: '2026-10' }).columns.length, 31);
  assert.equal(buildCreationChart(tasks, { now, month: 'drop table' }).month, '2026-11');
});

test('a year is the last 12 months or a calendar year, per month', () => {
  const last12 = buildCreationChart(tasks, { now, year: 'seneste' });
  assert.equal(last12.mode, 'year');
  assert.deepEqual([last12.from, last12.to, last12.columns.length, last12.total], ['2025-12', '2026-11', 12, 6]);
  const y2026 = buildCreationChart(tasks, { now, year: '2026' });
  assert.deepEqual([y2026.from, y2026.to, y2026.columns.length, y2026.total, y2026.title], ['2026-01', '2026-11', 11, 5, 'Hele 2026']);
  assert.equal(buildCreationChart(tasks, { now, year: '2025' }).total, 1);
  assert.deepEqual(last12.years, ['2026', '2025']);
  assert.equal(buildCreationChart(tasks, { now, year: '1999' }).mode, 'month');
});

test('an interval is shown per month, in either order, linking to the month filter', () => {
  const chart = buildCreationChart(tasks, { now, from: '2026-11', to: '2026-09' });
  assert.equal(chart.mode, 'interval');
  assert.deepEqual(chart.columns.map((column) => [column.key, column.count]), [['2026-09', 1], ['2026-10', 1], ['2026-11', 3]]);
  assert.deepEqual(chart.columns[0].filter, { maaned: '2026-09' });
  assert.equal(chart.total, 5);
  const long = buildCreationChart(tasks, { now, from: '2020-01', to: '2026-11', maxMonths: 12 });
  assert.equal(long.columns.length, 12);
  assert.equal(long.truncated, true);
});

test('dueState: open tasks with a deadline before today are overdue, within 30 days due soon; closed tasks never', () => {
  const { dueState } = require('../services/propbinder-analytics');
  const now = new Date(2026, 10, 12, 10, 0);
  assert.equal(dueState({ status: 'Skal udføres', dueDate: '2026-11-11T12:00:00' }, now), 'overskredet');
  assert.equal(dueState({ status: 'Skal udføres', dueDate: '2026-11-12T08:00:00' }, now), 'inden30');
  assert.equal(dueState({ status: 'Skal udføres', dueDate: '2026-12-30T08:00:00' }, now), '');
  assert.equal(dueState({ status: 'Afsluttet', dueDate: '2026-11-01T08:00:00' }, now), '');
  assert.equal(dueState({ status: 'Skal udføres', dueDate: null }, now), '');
});
