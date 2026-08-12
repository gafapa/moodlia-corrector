import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manifest references existing extension assets', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js ?? [])
  ];

  assert.equal(manifest.manifest_version, 3);
  for (const relativePath of referenced) {
    await fs.access(path.join(root, 'extension', relativePath));
  }
});

test('grader URL policy accepts only the configured HTTPS Moodle grading page', async () => {
  const api = await loadBackgroundApi();
  assert.equal(api.isSupportedGraderUrl('https://platega.edu.xunta.gal/mod/assign/view.php?id=4&action=grader'), true);
  assert.equal(api.isSupportedGraderUrl('http://platega.edu.xunta.gal/mod/assign/view.php?id=4&action=grader'), false);
  assert.equal(api.isSupportedGraderUrl('https://evil.example/mod/assign/view.php?action=grader'), false);
  assert.equal(api.isSupportedGraderUrl('https://platega.edu.xunta.gal/mod/assign/view.php?action=view'), false);
});

test('AI runtime configuration keeps only explicit provider routing fields', async () => {
  const api = await loadBackgroundApi();
  const config = api.sanitizeAiRuntimeConfig({ provider: 'ollama', model: 'qwen3', apiKey: 'must-not-persist', baseUrl: 'http://localhost' });
  assert.equal(config.provider, 'ollama');
  assert.equal(config.model, 'qwen3');
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
  assert.equal(Object.hasOwn(config, 'baseUrl'), false);
});

test('correction parser normalizes scores and Moodle rubric selections', async () => {
  const api = await loadBackgroundApi();
  const assignment = sampleAssignment();
  const correction = api.parseCorrectionResponse(JSON.stringify({
    studentFeedback: 'Bo traballo.',
    score: '8',
    maxScore: 10,
    rubricSelections: [{ criterionId: 'criterion-1', levelIndex: 1, criterionFeedback: 'A evidencia é suficiente.' }]
  }), assignment);

  assert.equal(correction.needsRepair, false);
  assert.equal(correction.studentFeedback, 'Bo traballo.');
  assert.equal(correction.score, 8);
  assert.equal(correction.maxScore, 10);
  assert.equal(correction.rubricSelections.length, 1);
  assert.equal(correction.rubricSelections[0].criterionId, 'criterion-1');
  assert.equal(correction.rubricSelections[0].levelIndex, 1);
  assert.equal(api.isCorrectionComplete(correction, assignment), true);
});

test('correction parser produces reviewable fallback data for invalid AI output', async () => {
  const api = await loadBackgroundApi();
  const assignment = sampleAssignment();
  const correction = api.parseCorrectionResponse('### Review manually', assignment);

  assert.equal(correction.needsRepair, true);
  assert.equal(correction.score, null);
  assert.match(correction.studentFeedback, /Review manually/);
  assert.equal(correction.rubricSelections.length, 1);
  assert.equal(api.isCorrectionComplete(correction, assignment), false);
});

test('generated correction prompt fixes language, schema, and evidence constraints', async () => {
  const api = await loadBackgroundApi();
  const prompt = api.buildCorrectionPrompt(sampleAssignment());
  assert.match(prompt, /Galician \(galego\)/);
  assert.match(prompt, /Return one valid JSON object only/);
  assert.match(prompt, /criterion-1/);
  assert.match(prompt, /maxScore must be exactly 10/);
  assert.match(prompt, /do not invent/i);
});

function sampleAssignment() {
  return {
    page: { language: 'gl' },
    assignmentTitle: 'Project',
    assignmentPrompt: 'Submit evidence.',
    maxScore: 10,
    gradingControls: { grade: { id: 'grade' } },
    rubric: [{
      id: 'criterion-1',
      description: 'Evidence quality',
      controls: { levelSelection: true },
      levels: [
        { index: 0, score: 0, text: 'Insufficient' },
        { index: 1, score: 10, text: 'Complete' }
      ]
    }]
  };
}

async function loadBackgroundApi() {
  const source = await fs.readFile(path.join(root, 'extension', 'src', 'background.js'), 'utf8');
  const event = { addListener() {} };
  const chrome = {
    action: { enable() {}, disable() {}, setTitle() {} },
    management: { getAll(callback) { callback([]); } },
    runtime: { lastError: null, onMessage: event, connect() { throw new Error('Not available in unit tests.'); } },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: {
      create(_options, callback) { callback?.({ id: 1 }); },
      get(_tabId, callback) { callback({ id: 1, url: '' }); },
      onActivated: event,
      onUpdated: event,
      query(_options, callback) { callback([]); }
    }
  };
  const sandbox = { AbortController, Buffer, URL, chrome, clearTimeout, console, crypto, fetch, setTimeout };
  sandbox.globalThis = sandbox;
  const exports = [
    'buildCorrectionPrompt',
    'isCorrectionComplete',
    'isSupportedGraderUrl',
    'parseCorrectionResponse',
    'sanitizeAiRuntimeConfig'
  ].join(',');
  vm.runInNewContext(`${source}\nglobalThis.__testApi = {${exports}};`, sandbox, { filename: 'background.js' });
  return sandbox.__testApi;
}
