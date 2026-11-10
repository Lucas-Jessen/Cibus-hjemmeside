const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContractService, safeName } = require('../services/contract-service');

const properties = [{ number: 'F4352', name: 'Prøvestenscenteret' }, { number: 'F4354', name: 'Rungsted Bytorv' }];

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kontrakter-'));
}

test('creates "<EjendomNr> <navn>/01 kontrakt" once per property and counts files', () => {
  const root = tempRoot();
  const service = createContractService({ root });
  assert.deepEqual(service.ensureStructure(properties), ['F4352 Prøvestenscenteret', 'F4354 Rungsted Bytorv']);
  assert.deepEqual(service.ensureStructure(properties), []);
  fs.writeFileSync(path.join(root, 'F4352 Prøvestenscenteret', '01 kontrakt', 'aftale.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'F4352 Prøvestenscenteret', '01 kontrakt', 'desktop.ini'), 'x');
  const [first, second] = service.list(properties);
  assert.equal(first.fileCount, 1);
  assert.deepEqual(first.folders.map((f) => f.name), ['01 kontrakt']);
  assert.equal(second.fileCount, 0);
});

test('a renamed property keeps its folder (found by EjendomNr), and extra folders are listed', () => {
  const root = tempRoot();
  const service = createContractService({ root });
  service.ensureStructure(properties);
  fs.mkdirSync(path.join(root, 'F4354 Rungsted Bytorv', '02 bilag'));
  service.ensureStructure([{ number: 'F4354', name: 'Rungsted Bytorv Center' }]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['F4352 Prøvestenscenteret', 'F4354 Rungsted Bytorv']);
  assert.deepEqual(service.list([properties[1]])[0].folders.map((f) => f.name), ['01 kontrakt', '02 bilag']);
});

test('only listed files are served; path tricks return null', () => {
  const root = tempRoot();
  const service = createContractService({ root });
  service.ensureStructure(properties);
  fs.writeFileSync(path.join(root, 'F4352 Prøvestenscenteret', '01 kontrakt', 'aftale.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'hemmelig.txt'), 'x');
  assert.equal(service.resolveFile(properties[0], '01 kontrakt', 'aftale.pdf'), path.join(root, 'F4352 Prøvestenscenteret', '01 kontrakt', 'aftale.pdf'));
  assert.equal(service.resolveFile(properties[0], '01 kontrakt', '../../hemmelig.txt'), null);
  assert.equal(service.resolveFile(properties[0], '..', 'hemmelig.txt'), null);
  assert.equal(service.resolveFile(properties[1], '01 kontrakt', 'aftale.pdf'), null);
  assert.equal(safeName('F4357 Øster Allé 24-30 / Lærkevej 1'), 'F4357 Øster Allé 24-30 Lærkevej 1');
});
