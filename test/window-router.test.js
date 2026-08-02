'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowRouter } = require('../lib/window-router');

class FakeWindow extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.destroyed = false;
    this.messages = [];
    this.webContents = { send: (...args) => this.messages.push(args) };
  }

  isDestroyed() { return this.destroyed; }
}

test('default new-window request stays with the most recently focused live window', async () => {
  const created = [];
  const router = createWindowRouter({
    createWindow: state => created.push(state),
    resolveEagleWindowState: async () => ({ view: { kind: 'folder', id: 'eagle' } })
  });
  const first = new FakeWindow('first');
  const second = new FakeWindow('second');
  router.track(first);
  router.track(second);

  first.emit('focus');
  second.emit('focus');
  second.emit('blur');
  await router.openDefault();

  assert.deepEqual(first.messages, []);
  assert.deepEqual(second.messages, [['command:new-window']]);
  assert.deepEqual(created, []);
});

test('default routing falls back through older windows and then Eagle', async () => {
  const created = [];
  const router = createWindowRouter({
    createWindow: state => created.push(state),
    resolveEagleWindowState: async () => ({ view: { kind: 'folder', id: 'eagle' } })
  });
  const first = new FakeWindow('first');
  const second = new FakeWindow('second');
  router.track(first);
  router.track(second);
  first.emit('focus');
  second.emit('focus');

  second.destroyed = true;
  second.emit('closed');
  await router.openDefault();
  assert.deepEqual(first.messages, [['command:new-window']]);

  first.destroyed = true;
  first.emit('closed');
  await router.openDefault();
  assert.deepEqual(created, [{ view: { kind: 'folder', id: 'eagle' } }]);
});
