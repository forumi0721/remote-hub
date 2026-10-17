const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/mobile-input.js'));
const modulePromise = import('data:text/javascript;base64,' + source.toString('base64'));

test('terminal control characters preserve Unicode and multi-character input', async () => {
  const { terminalControlCharacter } = await modulePromise;
  assert.equal(terminalControlCharacter('c'), '\x03');
  assert.equal(terminalControlCharacter('D'), '\x04');
  assert.equal(terminalControlCharacter('['), '\x1b');
  assert.equal(terminalControlCharacter(' '), '\x00');
  assert.equal(terminalControlCharacter('한'), '한');
  assert.equal(terminalControlCharacter('paste'), 'paste');
});

test('RDP text commits composed Unicode once, maps line endings and bounds batches', async () => {
  const { sendRdpText } = await modulePromise;
  const batches = [];
  const types = {
    DeviceEvent: Object.fromEntries(['unicodePressed', 'unicodeReleased', 'keyPressed', 'keyReleased'].map(type => [type, value => ({ type, value })])),
    InputTransaction: class { constructor() { this.events = []; } addEvent(event) { this.events.push(event); } }
  };
  sendRdpText({ applyInputs: transaction => batches.push(transaction.events) }, '한글😀\r\n\t' + 'a'.repeat(70), types);
  assert.equal(batches.length, 2);
  assert.ok(batches.every(batch => batch.length <= 128));
  const events = batches.flat();
  assert.deepEqual(events.slice(0, 2), [{ type: 'unicodePressed', value: '한' }, { type: 'unicodeReleased', value: '한' }]);
  assert.equal(events.filter(event => event.type === 'unicodePressed' && event.value === '😀').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'keyPressed').map(event => event.value), [0x1c, 0x0f]);
});
