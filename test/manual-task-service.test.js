const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManualTaskService } = require('../services/manual-task-service');

const properties = new Map([['F4355', { number: 'F4355', name: 'Vestamagercentret', address: 'Ugandavej 111', zipCode: '2770', city: 'Kastrup' }]]);

test('mail tasks become task rows with property, time spent and source; unknown property is explained', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manuelle-'));
  fs.writeFileSync(path.join(root, 'stoka.json'), JSON.stringify({
    source: { type: 'mail', subject: 'Tidsforbrug denne uge - Stoka', from: 'Steen Cerelius', received: '2026-11-12T08:51:05' },
    tasks: [
      { key: 'S-1', title: 'Ugandavej 111 – kloak', propertyNumber: 'F4355', mailDates: '10.–11/11', firstDate: '2026-11-10', timeSpent: '45 min. indtil nu', minutes: 45, assignedTo: 'Steen Cerelius' },
      { key: 'S-2', title: 'TDC – 5G-modem', propertyNumber: null, propertyNote: 'Ejendom fremgår ikke af mailen', firstDate: '2026-11-11', timeSpent: 'Ca. 5 min.' },
    ],
  }));
  fs.writeFileSync(path.join(root, 'ødelagt.json'), '{ ikke json');
  const { tasks, errors } = createManualTaskService({ root }).getTasks(properties);
  assert.equal(tasks.length, 2);
  assert.deepEqual([tasks[0].id, tasks[0].propertyNumber, tasks[0].property, tasks[0].status, tasks[0].createdAt, tasks[0].link.via], ['S-1', 'F4355', 'Vestamagercentret', 'Ikke angivet', '2026-11-10T00:00:00', 'mail']);
  assert.match(tasks[0].description, /Tidsforbrug: 45 min\. indtil nu/);
  assert.match(tasks[0].description, /Kilde: mail "Tidsforbrug denne uge - Stoka" fra Steen Cerelius/);
  assert.deepEqual([tasks[1].propertyNumber, tasks[1].propertyNote, tasks[1].assignedTo], [null, 'Ejendom fremgår ikke af mailen', 'Steen Cerelius']);
  assert.equal(errors.length, 1);
});

test('no folder means no manual tasks', () => {
  assert.deepEqual(createManualTaskService({ root: path.join(os.tmpdir(), 'findes-ikke-' + Date.now()) }).getTasks(properties).tasks, []);
});
