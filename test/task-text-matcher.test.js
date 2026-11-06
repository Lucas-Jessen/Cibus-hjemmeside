const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskTextMatcher } = require('../services/task-text-matcher');
const { createPropbinderService, buildLinks, filterTasksByPropertyList, filterCasesByPropertyList, caseStatusLabel } = require('../services/propbinder-service');

test('cases are part of the task list and refresh() fetches new ones', async () => {
  let caseList = [{ id: 'c1', propertyNumber: '37896', status: 'CaseStatus.Name.Open', createdAt: '2026-11-01T10:00:00', customerType: 'CustomerType.Company' }];
  const client = {
    getTasks: async () => [{ id: 't', number: 5, title: 'Lys i Rungsted Bytorv 1', createdAt: '2026-11-02T10:00:00' }],
    getProperties: async () => [{ id: 'p', number: '37896', financeUnit: 'F4354', name: 'Rungsted Bytorv' }],
    getTimeRegistrations: async () => [],
    getCases: async () => caseList,
  };
  const property = { number: 'F4354', name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', textKeys: ['Rungsted Bytorv 1-7'] };
  const service = createPropbinderService({ mode: 'live', backendClient: client, textMatching: true, propertyList: { configured: true, getProperties: () => ({ properties: [property], byNumber: new Map([['F4354', property]]), modifiedAt: '2026-11-01' }) } });
  const tasks = await service.getTasks();
  assert.deepEqual(tasks.map((task) => [task.kind, task.propertyNumber]), [['Opgave', 'F4354'], ['Sag', 'F4354']]);
  assert.equal(tasks[1].title, 'Sag fra virksomhed');
  assert.equal(tasks[1].status, 'Åben');
  caseList = [...caseList, { id: 'c2', propertyNumber: '37896', status: 'CaseStatus.Name.Closed', createdAt: '2026-11-03T09:00:00' }];
  const refreshed = await service.refresh();
  assert.equal(refreshed.filter((task) => task.kind === 'Sag').length, 2);
  assert.equal(refreshed[0].status, 'Lukket');
});

const cibus = [
  { number: 'F4354', name: 'Rungsted Bytorv', addresses: ['Rungsted Bytorv 1-7'] },
  { number: 'F4355', name: 'Vestamagercentret', addresses: ['Ugandavej 111'] },
  { number: 'F4350', name: 'Vallensbæk Stationstorv', addresses: ['Vallensbæk Stationstorv 1-87'] },
];

test('text matcher uses lease codes, property numbers and addresses, in that order', () => {
  const matcher = createTaskTextMatcher(cibus);
  assert.deepEqual(matcher.match({ title: 'Istandsættelse af lejemål - 1-4355-20-4' }), { number: 'F4355', via: 'lejemålsnr.', evidence: '1-4355-20' });
  assert.equal(matcher.match({ title: 'rek på sag', description: 'Jeres sag 180561 F4350 Vallensbæk' }).via, 'ejendomsnr. i tekst');
  assert.deepEqual(matcher.match({ title: 'Ny låsecylinder. Rungsted Bytorv 1. 2. sal.' }), { number: 'F4354', via: 'adresse/navn i tekst', evidence: 'Rungsted Bytorv' });
  assert.equal(matcher.match({ title: 'Udskift pære i Rungsted' }), null);
  assert.equal(matcher.match({ title: 'Lejemål 1-9999-1-1' }), null);
  assert.deepEqual(matcher.match({ title: 'Rungsted Bytorv og Vestamagercentret' }), { ambiguous: true });
});

test('names shared with properties outside the list are not used', () => {
  const matcher = createTaskTextMatcher(cibus, { foreignKeys: ['Vallensbæk Stationstorv'] });
  assert.equal(matcher.match({ title: 'Fraflytningssyn 1-5363-54-2 Vallensbæk Stationstorv 74' }), null);
  assert.equal(matcher.match({ title: 'Lys ved Vallensbæk Stationstorv 1-87' }).number, 'F4350');
});

test('tasks linked to another property by time registration are not moved by their text', () => {
  const allowed = new Map([['F4354', { name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7', zipCode: '2960', city: 'Rungsted Kyst' }]]);
  const links = buildLinks([{ id: 'a', number: '100', financeUnit: 'F9999' }], [{ taskNumber: 1, propertyNumber: '100' }]);
  const matcher = createTaskTextMatcher([cibus[0]]);
  const tasks = [{ id: '1', number: 1, title: 'Rungsted Bytorv 1' }, { id: '2', number: 2, title: 'Rungsted Bytorv 3' }, { id: '3', number: 3, title: 'Andet' }];
  const { tasks: shown, stats } = filterTasksByPropertyList(tasks, allowed, links, matcher);
  assert.deepEqual(shown.map((task) => task.id), ['2']);
  assert.equal(shown[0].link.via, 'adresse/navn i tekst');
  assert.deepEqual([stats.linkedByText, stats.otherProperties, stats.unlinked], [1, 1, 1]);
});

test('cases are kept on listed properties via financeUnit and get Danish status names', () => {
  const allowed = new Map([['F4354', { name: 'Rungsted Bytorv', address: 'Rungsted Bytorv 1-7' }]]);
  const links = buildLinks([{ id: 'p1', number: '37896', financeUnit: 'F4354' }, { id: 'p2', number: '1', financeUnit: 'F1000' }], []);
  const cases = filterCasesByPropertyList([
    { id: 'abcdef12-0000', propertyNumber: '37896', status: 'CaseStatus.Name.AwaitingAnswer', createdAt: '2026-10-01' },
    { id: 'x', propertyNumber: '1', status: 'CaseStatus.Name.Open' },
  ], allowed, links);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].propertyNumber, 'F4354');
  assert.equal(cases[0].status, 'Afventer svar');
  assert.equal(cases[0].open, true);
  assert.equal(caseStatusLabel('CaseStatus.Name.Closed'), 'Lukket');
});
