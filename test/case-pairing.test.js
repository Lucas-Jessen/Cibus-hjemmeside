const test = require('node:test');
const assert = require('node:assert/strict');
const { pairCasesWithTasks, createPropbinderService } = require('../services/propbinder-service');

const caseRow = (id, createdAt, assignedTo) => ({ id: `SAG-${id}`, kind: 'Sag', title: 'Sag fra virksomhed', description: 'Henvendelse', createdAt, assignedTo, status: 'Åben' });
const task = (id, createdAt, assignedTo, title = `Opgave ${id}`) => ({ id: String(id), number: id, title, description: `Tekst ${id}`, createdAt, assignedTo, status: 'Skal udføres', dueDate: '2026-11-20T12:00:00' });

test('a case takes title, text and number from the task its person created just before it', () => {
  const { cases, pairedTaskIds } = pairCasesWithTasks(
    [caseRow('A', '2026-11-04T12:00:17', 'Jan'), caseRow('B', '2026-11-05T14:40:49', 'Steen')],
    [task(1, '2026-11-04T11:59:58', 'Jan', 'Sprinkling Rungsted'), task(2, '2026-11-05T14:40:49', 'Steen'), task(3, '2026-11-04T12:00:00', 'Anden')],
  );
  assert.deepEqual(cases.map((c) => [c.id, c.title, c.number]), [['SAG-A', 'Sprinkling Rungsted', 1], ['SAG-B', 'Opgave 2', 2]]);
  assert.equal(cases[0].description, 'Tekst 1');
  assert.deepEqual(cases[0].pairedTask, { id: '1', number: 1, status: 'Skal udføres' });
  assert.deepEqual([...pairedTaskIds].sort(), ['1', '2']);
});

test('no pairing outside the window, with another person, or when ambiguous', () => {
  const { cases, pairedTaskIds } = pairCasesWithTasks(
    [caseRow('late', '2026-11-04T12:05:00', 'Jan'), caseRow('two', '2026-11-04T13:00:30', 'Jan'), caseRow('x', '2026-11-04T14:00:10', 'Ole'), caseRow('y', '2026-11-04T14:00:20', 'Ole')],
    [task(1, '2026-11-04T12:03:30', 'Jan'), task(2, '2026-11-04T13:00:00', 'Jan'), task(3, '2026-11-04T13:00:20', 'Jan'), task(4, '2026-11-04T14:00:00', 'Ole')],
  );
  assert.deepEqual(cases.map((c) => c.title), ['Sag fra virksomhed', 'Sag fra virksomhed', 'Sag fra virksomhed', 'Sag fra virksomhed']);
  assert.equal(pairedTaskIds.size, 0);
});

test('a paired task is shown once, as the case', async () => {
  const property = { number: 'F4354', name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', textKeys: ['Rungsted Bytorv 1-7'] };
  const client = {
    getTasks: async () => [{ id: 't', number: 319621, title: 'Sprinkling Rungsted Bytorv 1', text: 'Christian ringer', responsible: 'Jan', createdAt: '2026-11-04T12:00:06' }],
    getProperties: async () => [{ id: 'p', number: '37896', financeUnit: 'F4354', name: 'Rungsted Bytorv' }],
    getTimeRegistrations: async () => [],
    getCases: async () => [{ id: '20672642-aaaa', propertyNumber: '37896', status: 'CaseStatus.Name.Open', createdAt: '2026-11-04T12:00:17', responsible: 'Jan', customerType: 'CustomerType.Company' }],
  };
  const service = createPropbinderService({ mode: 'live', backendClient: client, textMatching: true, propertyList: { configured: true, getProperties: () => ({ properties: [property], byNumber: new Map([['F4354', property]]), modifiedAt: '2026-11-01' }) } });
  const tasks = await service.getTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].kind, tasks[0].title, tasks[0].number, tasks[0].status], ['Sag', 'Sprinkling Rungsted Bytorv 1', 319621, 'Åben']);
  assert.equal(service.getConfiguration().filter.casesWithTask, 1);
});
