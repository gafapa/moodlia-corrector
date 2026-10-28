import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('rapid panel provider changes discard a delayed profile lookup without mixing endpoints', async () => {
  const source = await fs.readFile(new URL('../src/content/moodleContent.js', import.meta.url), 'utf8');
  let releaseFirst;
  let firstReached;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const reached = new Promise(resolve => { firstReached = resolve; });
  let lookups = 0;
  const provider = { value: 'lm-studio' };
  const requests = [];
  const sandbox = {
    aiStatusRevision: 0, aiRuntimeStatus: {},
    getPanelElements: () => ({ provider, model: { value: '' } }),
    chrome: { storage: { local: { get: async () => {
      if (++lookups === 1) { firstReached(); await gate; }
      return { 'mca.aiProviderConfigs': { 'lm-studio': { baseUrl: 'http://localhost:1234/v1', model: 'studio' }, ollama: { baseUrl: 'http://localhost:11434', model: 'gemma' } } };
    } } } },
    sendBackgroundMessage: async message => { requests.push(message.config); return { ok: true, config: message.config }; },
    MoodliaCorrectorAiProviders: {}, MoodliaCorrectorI18n: { t: value => value },
    renderAiRuntimeControls() {}, refreshAiRuntimeStatus: async () => {}, setPanelStatus() {},
  };
  vm.runInNewContext(source.slice(source.indexOf('let aiSelectionRevision ='), source.indexOf('let settingsFrame =')) + '\nglobalThis.select = saveAiRuntimeSelection;', sandbox);
  const first = sandbox.select(true);
  await reached;
  provider.value = 'ollama';
  await sandbox.select(true);
  releaseFirst();
  await first;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, 'ollama');
  assert.equal(requests[0].baseUrl, 'http://localhost:11434');
  assert.equal(requests[0].model, 'gemma');
});
