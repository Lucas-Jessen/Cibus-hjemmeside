const test = require('node:test');
const assert = require('node:assert/strict');
const { pairCasesWithTasks, createPropbinderService } = require('../services/propbinder-service');

const caseRow = (id, createdAt, assignedTo) => ({ id: `SAG-${id}`, kind: 'Sag', title: 'Sag fra virksomhed', description: 'Henvendelse', createdAt, assignedTo, status: 'Åben', dueDate: null });
const task = (id, createdAt, assignedTo, title = `Opgave ${id}`) => ({ id: String(id), number: id, title, description: `Tekst ${id}`, createdAt, assignedTo, status: 'Skal udføres', dueDate: '2026-11-20T12:00:00' });

test('a case shows the title and text of the task created with it, but keeps its own status and deadline', () => {
  const { cases, pairs } = pairCasesWithTasks(
    [caseRow('A', '2026-11-04T12:00:17', 'Jan'), caseRow('B', '2026-11-05T14:40:49', 'Steen')],
    [task(1, '2026-11-04T11:59:58', 'Jan', 'Sprinkling Rungsted'), task(2, '2026-11-05T14:40:49', 'Steen'), task(3, '2026-11-04T12:00:00', 'Anden')],
  );
  assert.deepEqual(cases.map((c) => [c.id, c.title, c.status, c.dueDate]), [['SAG-A', 'Sprinkling Rungsted', 'Åben', null], ['SAG-B', 'Opgave 2', 'Åben', null]]);
  assert.equal(cases[0].description, 'Tekst 1');
  assert.equal(cases[0].titleFromTask, true);
  assert.deepEqual(cases[0].relatedTask, { id: '1', number: 1 });
  assert.equal(cases[0].number, undefined);
  assert.deepEqual([...pairs.keys()], ['SAG-A', 'SAG-B']);
});

test('no pairing outside the window, with another person, or when ambiguous', () => {
  const { cases, pairs } = pairCasesWithTasks(
    [caseRow('late', '2026-11-04T12:05:00', 'Jan'), caseRow('two', '2026-11-04T13:00:30', 'Jan'), caseRow('x', '2026-11-04T14:00:10', 'Ole'), caseRow('y', '2026-11-04T14:00:20', 'Ole')],
    [task(1, '2026-11-04T12:03:30', 'Jan'), task(2, '2026-11-04T13:00:00', 'Jan'), task(3, '2026-11-04T13:00:20', 'Jan'), task(4, '2026-11-04T14:00:00', 'Ole')],
  );
  assert.deepEqual(cases.map((c) => c.title), ['Sag fra virksomhed', 'Sag fra virksomhed', 'Sag fra virksomhed', 'Sag fra virksomhed']);
  assert.equal(pairs.size, 0);
});

function serviceWith({ tasks, cases, timeRegistrations = [], properties = [{ id: 'p', number: '37896', financeUnit: 'F4354', name: 'Rungsted Bytorv' }] }) {
  const property = { number: 'F4354', name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', textKeys: ['Rungsted Bytorv 1-7'] };
  const client = { getTasks: async () => tasks, getProperties: async () => properties, getTimeRegistrations: async () => timeRegistrations, getCases: async () => cases };
  return createPropbinderService({ mode: 'live', backendClient: client, textMatching: true, propertyList: { configured: true, getProperties: () => ({ properties: [property], byNumber: new Map([['F4354', property]]), modifiedAt: '2026-11-01' }) } });
}

test('case and task are two rows, each with its own status; the task gets the case property when it had none', async () => {
  const service = serviceWith({
    tasks: [{ id: 't', number: 319648, title: 'Rep efter gammel vandskade - Apoteket', text: 'Tekst', responsible: 'Jan', createdAt: '2026-11-05T07:28:00', status: 'Skal udføres' }],
    cases: [{ id: '598ce0c9-aaaa', propertyNumber: '37896', status: 'CaseStatus.Name.Open', createdAt: '2026-11-05T07:28:31', responsible: 'Jan', customerType: 'CustomerType.Company' }],
  });
  const rows = await service.getTasks();
  assert.equal(rows.length, 2);
  const [caseRowOut] = rows.filter((r) => r.kind === 'Sag');
  const [taskRowOut] = rows.filter((r) => r.kind === 'Opgave');
  assert.deepEqual([caseRowOut.status, caseRowOut.title, caseRowOut.relatedTask.number], ['Åben', 'Rep efter gammel vandskade - Apoteket', 319648]);
  assert.deepEqual([taskRowOut.status, taskRowOut.propertyNumber, taskRowOut.link.via, taskRowOut.relatedCase], ['Skal udføres', 'F4354', 'henvendelse', caseRowOut.id]);
  assert.equal(service.getConfiguration().filter.linkedByCase, 1);
});

test('when Propbinder does not answer, the last cases and links are kept instead of emptying the list', async () => {
  let fail = false;
  const property = { number: 'F4354', name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', textKeys: ['Rungsted Bytorv 1-7'] };
  const client = {
    getTasks: async () => [{ id: 't', number: 5, title: 'Lys', responsible: 'Ole', createdAt: '2026-11-01T08:00:00' }],
    getProperties: async () => { if (fail) throw new Error('fetch failed'); return [{ id: 'p', number: '37896', financeUnit: 'F4354', name: 'Rungsted Bytorv' }]; },
    getTimeRegistrations: async () => { if (fail) throw new Error('fetch failed'); return [{ taskNumber: 5, propertyNumber: '37896' }]; },
    getCases: async () => { if (fail) throw new Error('fetch failed'); return [{ id: 'c1-aaaa', propertyNumber: '37896', status: 'CaseStatus.Name.Open', createdAt: '2026-11-05T07:28:31', responsible: 'Jan' }]; },
  };
  const service = createPropbinderService({ mode: 'live', backendClient: client, linkCacheTtlMs: 0, propertyList: { configured: true, getProperties: () => ({ properties: [property], byNumber: new Map([['F4354', property]]), modifiedAt: '2026-11-01' }) } });
  assert.deepEqual((await service.refresh()).map((r) => r.kind).sort(), ['Opgave', 'Sag']);
  fail = true;
  assert.deepEqual((await service.refresh()).map((r) => r.kind).sort(), ['Opgave', 'Sag']);
  assert.ok(service.getConfiguration().warnings.some((w) => /seneste hentning/.test(w)));
});

test('a paired task linked to another property by time registration is not moved onto the case property', async () => {
  const service = serviceWith({
    tasks: [{ id: 't', number: 5, title: 'Andet arbejde', responsible: 'Jan', createdAt: '2026-11-05T07:28:00' }],
    cases: [{ id: 'c1-aaaa', propertyNumber: '37896', status: 'CaseStatus.Name.Open', createdAt: '2026-11-05T07:28:31', responsible: 'Jan' }],
    properties: [{ id: 'p', number: '37896', financeUnit: 'F4354', name: 'Rungsted Bytorv' }, { id: 'q', number: '1', financeUnit: 'F9999', name: 'Anden' }],
    timeRegistrations: [{ taskNumber: 5, propertyNumber: '1' }],
  });
  const rows = await service.getTasks();
  assert.deepEqual(rows.map((r) => r.kind), ['Sag']);
});
