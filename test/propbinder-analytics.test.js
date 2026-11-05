const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaskAnalytics, statusLabel, titleKey } = require('../services/propbinder-analytics');

const task = (overrides) => ({ title: 'Opgave', status: 'Ukendt', statusId: null, property: null, propertyNumber: null, assignedTo: null, createdAt: null, dueDate: null, ...overrides });

test('keeps unmapped status ids apart and uses mapped names when available', () => {
  assert.equal(statusLabel(task({ statusId: '8a7883dd-21b7-41ee-9e6e-b0e11992eb18' })), 'Ukendt (8a7883dd)');
  assert.equal(statusLabel(task({ status: 'Åben', statusId: '8a7883dd-21b7-41ee-9e6e-b0e11992eb18' })), 'Åben');
  assert.equal(statusLabel(task({})), 'Ukendt');
});

test('groups recurring titles regardless of case, spacing and trailing punctuation', () => {
  assert.equal(titleKey('  Ugentlig  grøn pleje og renhold. '), titleKey('ugentlig grøn pleje og renhold'));

  const analytics = buildTaskAnalytics([
    task({ title: 'Ugentlig grøn pleje', property: 'Kamillehuset' }),
    task({ title: 'ugentlig grøn pleje.', property: 'Kamillehuset' }),
    task({ title: 'Ugentlig  grøn pleje', property: '8Tallet' }),
    task({ title: 'Engangsopgave', property: '8Tallet' }),
  ], { now: new Date('2026-10-20T12:00:00Z') });

  assert.deepEqual(analytics.recurringTitles, [{ title: 'Ugentlig grøn pleje', count: 3, propertyCount: 2 }]);
  assert.equal(analytics.totals.recurringGroups, 1);
  assert.equal(analytics.totals.recurringTasks, 3);
});

test('counts tasks per property, status, responsible and month', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const analytics = buildTaskAnalytics([
    task({ property: 'Kamillehuset', propertyNumber: 'F3663', statusId: 'aaaaaaaa-1', assignedTo: 'Jørgen', createdAt: '2026-10-02T08:00:00Z' }),
    task({ property: 'Kamillehuset', propertyNumber: 'F3663', statusId: 'aaaaaaaa-1', assignedTo: 'Jørgen', createdAt: '2026-09-10T08:00:00Z' }),
    task({ property: '8Tallet', propertyNumber: 'F3062', statusId: 'bbbbbbbb-2', createdAt: '2025-01-10T08:00:00Z' }),
  ], { now });

  assert.deepEqual(analytics.byProperty, [
    { property: 'Kamillehuset', propertyNumber: 'F3663', count: 2 },
    { property: '8Tallet', propertyNumber: 'F3062', count: 1 },
  ]);
  assert.deepEqual(analytics.statuses, [{ label: 'Ukendt (aaaaaaaa)', count: 2 }, { label: 'Ukendt (bbbbbbbb)', count: 1 }]);
  assert.deepEqual(analytics.byResponsible, [{ name: 'Jørgen', count: 2 }]);
  assert.equal(analytics.perMonth.length, 12);
  assert.equal(analytics.perMonth.at(-1).key, '2026-10');
  assert.equal(analytics.perMonth.at(-1).count, 1);
  assert.equal(analytics.perMonth.at(-2).count, 1);
  assert.equal(analytics.perMonth.reduce((sum, month) => sum + month.count, 0), 2);
  assert.equal(analytics.totals.properties, 2);
});

test('counts overdue and soon-due tasks that are not closed', () => {
  const analytics = buildTaskAnalytics([
    task({ dueDate: '2026-10-01' }),
    task({ dueDate: '2026-10-01', status: 'Afsluttet' }),
    task({ dueDate: '2026-11-05' }),
    task({ dueDate: '2027-01-01' }),
  ], { now: new Date('2026-10-20T12:00:00Z') });

  assert.equal(analytics.totals.overdue, 1);
  assert.equal(analytics.totals.dueSoon, 1);
});

test('treats Propbinder statuses Udført and Aflyst as closed', () => {
  const analytics = buildTaskAnalytics([
    task({ status: 'Udført', dueDate: '2026-10-01' }),
    task({ status: 'Aflyst', dueDate: '2026-10-01' }),
    task({ status: 'Overskredet', dueDate: '2026-10-01' }),
    task({ status: 'Skal udføres', dueDate: '2026-10-25' }),
  ], { now: new Date('2026-10-20T12:00:00Z') });

  assert.equal(analytics.totals.overdue, 1);
  assert.equal(analytics.totals.dueSoon, 1);
});
