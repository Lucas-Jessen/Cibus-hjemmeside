const test = require('node:test');
const assert = require('node:assert/strict');
const { createPropbinderService, normalizeTask, parseStatusLabels } = require('../services/propbinder-service');

test('mock mode returns normalized task data with safe defaults', async () => {
  const service = createPropbinderService({ mode: 'mock' });
  const tasks = await service.getTasks();

  assert.ok(tasks.length >= 1);
  assert.equal(tasks[0].id, 'MOCK-187683');
  assert.equal(tasks[0].status, 'Igangværende');
  assert.equal(tasks[0].priority, 'Normal');
  assert.equal(tasks[0].property, 'Testejendom');
  assert.equal(typeof tasks[0].title, 'string');
  assert.equal(tasks.every((task) => !task.externalApiKey), true);
});

test('live mode fails clearly when credentials are missing', async () => {
  const service = createPropbinderService({ mode: 'live' });

  await assert.rejects(service.getTasks(), /PROPBINDER_USERNAME/);
});

test('normalizes Propbinder AllTask fields and maps status ids to labels', () => {
  const statusId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const task = normalizeTask({
    id: '9d5a1b3e-0000-4000-8000-000000000001',
    number: 1042,
    title: 'Tjek tagrender',
    text: 'Rens og kontrollér tagrender.',
    responsible: 'Driftsteam',
    createdAt: '2026-10-01T08:00:00Z',
    lastModified: '2026-10-10T09:30:00Z',
    status: statusId,
    deadline: '2026-11-01T00:00:00Z',
  }, parseStatusLabels(`${statusId.toUpperCase()}=Åben; other=Afsluttet`));

  assert.equal(task.id, '1042');
  assert.equal(task.description, 'Rens og kontrollér tagrender.');
  assert.equal(task.assignedTo, 'Driftsteam');
  assert.equal(task.dueDate, '2026-11-01T00:00:00Z');
  assert.equal(task.updatedAt, '2026-10-10T09:30:00Z');
  assert.equal(task.status, 'Åben');
  assert.equal(task.statusId, statusId);
  assert.equal(task.property, null);
  assert.equal(task.priority, null);
});

test('unmapped status ids are shown as unknown but kept for mapping', () => {
  const task = normalizeTask({ id: 'x', status: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });

  assert.equal(task.status, 'Ukendt');
  assert.equal(task.statusId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
});

test('live mode caches tasks for the configured period', async () => {
  let calls = 0;
  let clock = 0;
  const service = createPropbinderService({
    mode: 'live',
    backendClient: { getTasks: async () => { calls += 1; return [{ id: 'a', title: 'A' }]; } },
    cacheTtlMs: 1000,
    now: () => clock,
  });

  await service.getTasks();
  clock = 999;
  await service.getTasks();
  assert.equal(calls, 1);
  clock = 1000;
  await service.getTasks();
  assert.equal(calls, 2);
  assert.equal(service.getConfiguration().source, 'Propbinder Partner API');
});

function fakePropertyList(numbers) {
  const properties = numbers.map((number) => ({ number, name: `Ejendom ${number}`, address: 'Vej 1', zipCode: '2100', city: 'København Ø' }));
  return { configured: true, getProperties: () => ({ properties, byNumber: new Map(properties.map((property) => [property.number, property])), modifiedAt: '2026-10-20T10:00:00.000Z' }) };
}

test('live mode only shows tasks linked to properties on the property list', async () => {
  const service = createPropbinderService({
    mode: 'live',
    propertyList: fakePropertyList(['F2020', 'F3050']),
    backendClient: {
      getTasks: async () => [
        { id: 'a', number: 1, title: 'Direkte felt', propertyNumber: 'f2020' },
        { id: 'b', number: 2, title: 'Via Propbinder-ejendom', propertyId: 'P-1' },
        { id: 'c', number: 3, title: 'Via tidsregistrering' },
        { id: 'd', number: 4, title: 'Anden ejendom', propertyNumber: 'F9999' },
        { id: 'e', number: 5, title: 'Ukendt ejendom' },
      ],
      getProperties: async () => [{ id: 'p-1', number: 'F3050', externalId: null }],
      getTimeRegistrations: async () => [{ taskNumber: 3, propertyNumber: 'F2020' }, { taskNumber: 4, propertyNumber: null }],
    },
  });

  const tasks = await service.getTasks();
  assert.deepEqual(tasks.map((task) => [task.title, task.propertyNumber, task.property]), [
    ['Direkte felt', 'F2020', 'Ejendom F2020'],
    ['Via Propbinder-ejendom', 'F3050', 'Ejendom F3050'],
    ['Via tidsregistrering', 'F2020', 'Ejendom F2020'],
  ]);
  assert.equal(tasks[0].propertyAddress, 'Vej 1, 2100 København Ø');
  const { filter, warnings } = service.getConfiguration();
  assert.deepEqual(filter, { total: 5, shown: 3, unlinked: 1, otherProperties: 1, linkedByData: 3, linkedByText: 0, ambiguous: 0, textMatching: false, propertyCount: 2, listModifiedAt: '2026-10-20T10:00:00.000Z', cases: 0, casesTotal: 0, casesWithTask: 0, pairedAlreadyShown: 0 });
  assert.deepEqual(tasks.map((task) => task.link.via), ['ejendomsfelt', 'ejendomsfelt', 'tidsregistrering']);
  assert.deepEqual(warnings, []);
});

test('live mode keeps filtering and warns when link data cannot be fetched', async () => {
  const service = createPropbinderService({
    mode: 'live',
    propertyList: fakePropertyList(['F2020']),
    backendClient: {
      getTasks: async () => [{ id: 'a', number: 1, title: 'Direkte', propertyNumber: 'F2020' }, { id: 'b', number: 2, title: 'Ukendt' }],
      getProperties: async () => { throw new Error('Propbinder svarede 403'); },
      getTimeRegistrations: async () => [],
    },
  });

  assert.deepEqual((await service.getTasks()).map((task) => task.title), ['Direkte']);
  assert.match(service.getConfiguration().warnings[0], /Ejendomme kunne ikke hentes.*403/);
});

test('live mode fails closed when the property list cannot be read', async () => {
  const service = createPropbinderService({
    mode: 'live',
    propertyList: { configured: true, getProperties: () => { throw new Error('Ejendomslisten blev ikke fundet: x.xlsx'); } },
    backendClient: { getTasks: async () => [{ id: 'a', title: 'A' }] },
  });

  await assert.rejects(service.getTasks(), /Ejendomslisten blev ikke fundet/);
});

test('translates Propbinder property numbers to the list via financeUnit', async () => {
  const service = createPropbinderService({
    mode: 'live',
    propertyList: fakePropertyList(['F2020', 'F3050']),
    backendClient: {
      getTasks: async () => [
        { id: 'a', number: 10, title: 'Tidsregistrering på Propbinder-nummer' },
        { id: 'b', number: 11, title: 'Propbinder-ejendom', propertyId: 'P-2' },
        { id: 'c', number: 12, title: 'Anden kunde' },
      ],
      getProperties: async () => [
        { id: 'p-1', number: '37649', financeUnit: 'F2020' },
        { id: 'p-2', number: '37644', financeUnit: 'f3050' },
        { id: 'p-3', number: '40000', financeUnit: 'X1' },
      ],
      getTimeRegistrations: async () => [{ taskNumber: 10, propertyNumber: '37649' }, { taskNumber: 12, propertyNumber: '40000' }],
    },
  });

  const tasks = await service.getTasks();
  assert.deepEqual(tasks.map((task) => [task.title, task.propertyNumber]), [
    ['Tidsregistrering på Propbinder-nummer', 'F2020'],
    ['Propbinder-ejendom', 'F3050'],
  ]);
  assert.equal(service.getConfiguration().filter.otherProperties, 1);
});

test('serves the last tasks while refreshing and keeps them when a refresh fails', async () => {
  let clock = 0;
  let fail = false;
  let calls = 0;
  const service = createPropbinderService({
    mode: 'live',
    cacheTtlMs: 1000,
    now: () => clock,
    backendClient: { getTasks: async () => { calls += 1; if (fail) throw new Error('timeout'); return [{ id: String(calls), title: `Hentning ${calls}` }]; } },
  });

  assert.equal((await service.getTasks())[0].title, 'Hentning 1');
  clock = 2000;
  fail = true;
  assert.equal((await service.getTasks())[0].title, 'Hentning 1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.match(service.getConfiguration().warnings.at(-1), /Seneste opdatering fejlede \(timeout\)/);
  fail = false;
  await service.getTasks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.getTasks())[0].title, 'Hentning 3');
  assert.deepEqual(service.getConfiguration().warnings, []);
});
