import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../extension/src/runtimeClient.js', import.meta.url), 'utf8');
const setup = () => {
  const messages = [];
  const intervals = new Set();
  const timers = new Set();
  let onMessage;
  let onDisconnect;
  let disconnects = 0;
  const runtime = {
    sendMessage: async message => ({ short: message.type }),
    connect: () => ({
      postMessage: message => messages.push(message),
      disconnect: () => { disconnects++; onDisconnect(); },
      onMessage: { addListener: listener => { onMessage = listener; } },
      onDisconnect: { addListener: listener => { onDisconnect = listener; } },
    }),
  };
  const sandbox = {
    chrome: { runtime },
    setInterval: callback => { intervals.add(callback); return callback; },
    clearInterval: callback => intervals.delete(callback),
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback),
  };
  vm.runInNewContext(source, sandbox);
  return { send: sandbox.MoodliaCorrectorRuntime.send, messages, intervals, timers, runtime,
    reply: response => onMessage(response), disconnect: () => onDisconnect(), disconnects: () => disconnects };
};

test('long requests use a port with heartbeats and release all resources after a response', async () => {
  const api = setup();
  const pending = api.send({ type: 'mca.correctAssignment', requestId: 'fictional' });
  assert.equal(api.messages[0].requestId, 'fictional');
  for (const heartbeat of api.intervals) heartbeat();
  assert.equal(api.messages[1].type, 'mca.heartbeat');
  api.reply({ ok: true, correction: 'fictional' });
  assert.equal((await pending).correction, 'fictional');
  assert.equal(api.intervals.size, 0);
  assert.equal(api.timers.size, 0);
  assert.equal(api.disconnects(), 1);
});

test('worker disconnect rejects a pending request without retrying or leaking timers', async () => {
  const api = setup();
  const pending = api.send({ type: 'mca.testAiConnection' });
  api.disconnect();
  await assert.rejects(pending, /connection closed before completion/);
  assert.equal(api.messages.length, 1);
  assert.equal(api.intervals.size, 0);
  assert.equal(api.timers.size, 0);
});

test('long request deadline disconnects its port and short requests retain normal messaging', async () => {
  const api = setup();
  assert.equal((await api.send({ type: 'mca.getDiagnostics' })).short, 'mca.getDiagnostics');
  assert.equal(api.messages.length, 0);
  const pending = api.send({ type: 'mca.correctAssignment' });
  for (const deadline of [...api.timers]) deadline();
  await assert.rejects(pending, /exceeded 60 minutes/);
  assert.equal(api.disconnects(), 1);
  assert.equal(api.intervals.size, 0);
});

test('progress messages reach the caller without settling the long request', async () => {
  const api = setup();
  const progress = [];
  const pending = api.send({ type: 'mca.correctAssignment', requestId: 'fictional' }, { onProgress: value => progress.push(value) });
  api.reply({ type: 'mca.progress', progress: { stage: 'read', current: 1, total: 2 } });
  api.reply({ type: 'mca.progress', progress: { stage: 'grade' } });
  assert.equal(api.disconnects(), 0);
  api.reply({ ok: true, correction: 'fictional' });
  assert.equal((await pending).correction, 'fictional');
  assert.deepEqual(progress.map(value => value.stage), ['read', 'grade']);
});
