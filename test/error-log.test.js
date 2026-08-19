'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createErrorLog } = require('../lib/error-log');

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-errorlog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function makeClock(startMs = 1700000000000) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: ms => { current += ms; }
  };
}

test('writes a formatted entry with indented detail and creates the logs directory', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'logs', 'error.log');
  const log = createErrorLog({ file });
  await log.write({
    level: 'error',
    source: 'main',
    message: 'uncaughtException: boom',
    detail: 'Error: boom\n    at explode (main.js:1:1)'
  });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[error\] \[main\] uncaughtException: boom\n/);
  assert.match(text, /\n {4}Error: boom\n {4} {4}at explode \(main\.js:1:1\)\n/);
});

test('sanitizes hostile renderer payloads: bad level, object message, oversized detail', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'error.log');
  const log = createErrorLog({ file });
  await log.write({
    level: 'evil',
    source: 'renderer#7',
    message: { message: 'multi\nline message' },
    detail: 'x'.repeat(9000)
  });
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /\[error\] \[renderer#7\] multi line message\n/);
  assert.ok(text.includes('…（已截断）'));
  assert.ok(text.length < 9000);
  // Error instances serialize to their stack.
  const error = new Error('real failure');
  await log.write({ message: 'wrapper', detail: error });
  const next = await fs.readFile(file, 'utf8');
  assert.ok(next.includes('real failure'));
});

test('rotates when the file would exceed maxBytes and prunes beyond maxFiles', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'error.log');
  const clock = makeClock();
  const log = createErrorLog({ file, maxBytes: 200, maxFiles: 2, now: clock.now });
  const filler = index => ({ message: `entry-${index}-${'x'.repeat(120)}` });
  await log.write(filler(1));
  clock.advance(10000);
  await log.write(filler(2));
  clock.advance(10000);
  await log.write(filler(3));
  const current = await fs.readFile(file, 'utf8');
  const previous = await fs.readFile(`${file}.1`, 'utf8');
  assert.ok(current.includes('entry-3'));
  assert.ok(previous.includes('entry-2'));
  await assert.rejects(() => fs.stat(`${file}.2`), /ENOENT/);
});

test('collapses rapid repeats into a suppression note', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'error.log');
  const clock = makeClock();
  const log = createErrorLog({ file, repeatWindowMs: 5000, now: clock.now });
  await log.write({ message: 'same failure' });
  clock.advance(1000);
  await log.write({ message: 'same failure' });
  clock.advance(1000);
  await log.write({ message: 'same failure' });
  clock.advance(1000);
  await log.write({ message: 'different failure' });
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text.match(/same failure/g).length, 1);
  assert.match(text, /上一条日志在短时间内重复出现 2 次/);
  assert.ok(text.includes('different failure'));
  // Same message after the window logs normally again.
  clock.advance(60000);
  await log.write({ message: 'different failure' });
  const next = await fs.readFile(file, 'utf8');
  assert.equal(next.match(/different failure/g).length, 2);
});

test('stops writing after the per-session entry cap with a single notice', async t => {
  const root = await makeRoot(t);
  const file = path.join(root, 'error.log');
  const clock = makeClock();
  const log = createErrorLog({ file, maxEntries: 2, now: clock.now });
  for (let index = 0; index < 5; index += 1) {
    clock.advance(10000);
    await log.write({ message: `entry ${index}` });
  }
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('entry 0'));
  assert.ok(text.includes('entry 1'));
  assert.ok(!text.includes('entry 2'));
  assert.equal(text.match(/日志条数已达上限/g).length, 1);
});

test('write never rejects even when the filesystem fails', async () => {
  const brokenFs = {
    mkdir: async () => { throw new Error('disk full'); },
    stat: async () => { throw new Error('disk full'); },
    appendFile: async () => { throw new Error('disk full'); },
    rename: async () => { throw new Error('disk full'); },
    unlink: async () => { throw new Error('disk full'); }
  };
  const log = createErrorLog({ file: '/nonexistent/error.log', fs: brokenFs });
  await log.write({ message: 'should not throw' });
  await log.write({ message: 'still should not throw' });
});
