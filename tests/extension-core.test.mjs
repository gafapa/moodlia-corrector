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
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js ?? [])
  ];

  assert.equal(manifest.manifest_version, 3);
  for (const relativePath of referenced) {
    await fs.access(path.join(root, 'extension', relativePath));
  }
  await fs.access(path.join(root, 'extension', 'src', 'options', 'options.js'));
  await fs.access(path.join(root, 'extension', 'src', 'options', 'options.css'));
  for (const asset of ['src/attachments/reader.html', 'src/attachments/reader.js', 'lib/pdf.mjs', 'lib/pdf.worker.mjs', 'lib/fflate.mjs']) {
    await fs.access(path.join(root, 'extension', asset));
  }
});

test('grader URL policy accepts Moodle assignment grader pages on any HTTPS Moodle site', async () => {
  const api = await loadBackgroundApi();
  assert.equal(api.isSupportedGraderUrl('https://campus.example.edu/mod/assign/view.php?id=4&action=grader'), true);
  assert.equal(api.isSupportedGraderUrl('https://campus.example.edu/moodle/mod/assign/view.php?id=4&action=grader'), true);
  assert.equal(api.isSupportedGraderUrl('http://campus.example.edu/mod/assign/view.php?id=4&action=grader'), false);
  assert.equal(api.isSupportedGraderUrl('https://campus.example.edu/mod/quiz/view.php?action=grader'), false);
  assert.equal(api.isSupportedGraderUrl('https://campus.example.edu/mod/assign/view.php?action=view'), false);
});

test('direct AI configuration supports Ollama and OpenAI-compatible endpoints', async () => {
  const api = await loadBackgroundApi();
  const config = api.sanitizeAiConfig({ provider: 'ollama', model: 'qwen3', apiKey: 'must-not-persist', baseUrl: 'http://localhost:11434' });
  assert.equal(config.provider, 'ollama');
  assert.equal(config.model, 'qwen3');
  assert.equal(config.baseUrl, 'http://localhost:11434');
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
  assert.throws(() => api.sanitizeAiConfig({ provider: 'openai-compatible', baseUrl: 'http://api.example.test' }));
  assert.throws(() => api.sanitizeAiConfig({ provider: 'openai-compatible', baseUrl: 'https://user:secret@api.example.test' }));
  assert.throws(() => api.sanitizeAiConfig({ provider: 'openai-compatible', baseUrl: 'https://api.example.test?key=secret' }));
  assert.equal(api.sanitizeAiConfig({ provider: 'ollama', baseUrl: 'http://[::1]:11434' }).baseUrl, 'http://[::1]:11434');
});

test('direct AI requests use provider-native endpoints without exposing a key to Moodle', async () => {
  const api = await loadBackgroundApi();
  const messages = [{ role: 'user', content: 'Return JSON.' }];
  const ollama = api.createDirectChatRequest(
    { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3' },
    {},
    messages,
  );
  assert.equal(ollama.endpoint, 'http://127.0.0.1:11434/api/chat');
  assert.equal(ollama.body.format, 'json');
  assert.equal(Object.hasOwn(ollama.headers, 'Authorization'), false);

  const compatible = api.createDirectChatRequest(
    { provider: 'openai-compatible', baseUrl: 'https://api.example.test/v1', model: 'gpt-test' },
    { apiKey: 'session-secret' },
    messages,
  );
  assert.equal(compatible.endpoint, 'https://api.example.test/v1/chat/completions');
  assert.equal(compatible.headers.Authorization, 'Bearer session-secret');
  assert.equal(compatible.body.response_format.type, 'json_object');
});

test('direct AI requests reject redirects and return provider metadata', async () => {
  let requestInit;
  const api = await loadBackgroundApi({
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"studentFeedback":"OK"}' } }] }), { status: 200 });
    },
  });

  const response = await api.requestDirectChat(
    { provider: 'openai-compatible', baseUrl: 'https://api.example.test/v1', model: 'gpt-test' },
    { apiKey: 'session-secret' },
    [{ role: 'user', content: 'Return JSON.' }],
  );

  assert.equal(requestInit.redirect, 'error');
  assert.equal(response.provider, 'openai-compatible');
  assert.equal(response.model, 'gpt-test');
});

test('Moodle attachments must stay on the HTTPS grading-page origin', async () => {
  const api = await loadBackgroundApi();
  assert.equal(
    api.normalizeMoodleAttachmentUrl('/pluginfile.php/1/file.txt?forcedownload=1#preview', 'https://campus.example.edu/mod/assign/view.php'),
    'https://campus.example.edu/pluginfile.php/1/file.txt?forcedownload=1',
  );
  assert.throws(() => api.normalizeMoodleAttachmentUrl('https://files.example.test/file.txt', 'https://campus.example.edu/mod/assign/view.php'));
  assert.throws(() => api.normalizeMoodleAttachmentUrl('http://campus.example.edu/file.txt', 'https://campus.example.edu/mod/assign/view.php'));
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
  const prompt = api.buildCorrectionPrompt({
    ...sampleAssignment(),
    page: { language: 'gl', url: 'https://campus.example.edu/private-grader' },
    courseName: 'Sensitive course name',
    studentName: 'Sensitive student name',
    submissionFiles: [{ id: 'file-1', name: 'student-name.txt', url: 'https://campus.example.edu/pluginfile.php/1/student-name.txt' }],
  });
  assert.match(prompt, /Galician \(galego\)/);
  assert.match(prompt, /Return one valid JSON object only/);
  assert.match(prompt, /criterion-1/);
  assert.match(prompt, /maxScore must be exactly 10/);
  assert.match(prompt, /do not invent/i);
  assert.doesNotMatch(prompt, /Sensitive course name|Sensitive student name|private-grader|student-name\.txt/);
});

test('partial settings updates preserve a stored endpoint after a worker restart', async () => {
  const localData = { 'mca.aiConfig': { provider: 'openai-compatible', baseUrl: 'https://school.example/v1', model: 'old' } };
  const api = await loadBackgroundApi({ localData });
  await api.saveAiConfig({ model: 'new', provider: undefined });
  assert.equal(localData['mca.aiConfig'].baseUrl, 'https://school.example/v1');
  assert.equal(localData['mca.aiConfig'].model, 'new');
  assert.equal(localData['mca.aiConfig'].provider, 'openai-compatible');
});

test('keys are bound to their destination and cleared on destination changes', async () => {
  const localData = {};
  const sessionData = {};
  const api = await loadBackgroundApi({ localData, sessionData });
  const config = await api.saveAiConfig({ provider: 'openai-compatible', baseUrl: 'https://first.example/v1', model: 'model', apiKey: 'fictional-key' });
  assert.equal((await api.loadBoundAiSecret(config)).apiKey, 'fictional-key');
  await api.saveAiConfig({ model: 'second-model' });
  assert.equal((await api.loadBoundAiSecret(config)).apiKey, 'fictional-key');
  const changed = await api.saveAiConfig({ baseUrl: 'https://second.example/v1' });
  assert.equal((await api.loadBoundAiSecret(changed)).apiKey, undefined);
  assert.equal(JSON.stringify(localData).includes('fictional-key'), false);
});

test('connection status checks the server and rejects a missing model', async () => {
  const localData = { 'mca.aiConfig': { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'missing' } };
  let requestedUrl;
  const api = await loadBackgroundApi({ localData, fetchImpl: async (url) => {
    requestedUrl = url;
    return Response.json({ models: [{ name: 'installed' }] });
  } });
  const status = await api.getDirectAiStatus();
  assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/tags');
  assert.equal(status.appConfig.reachable, true);
  assert.equal(status.providers[0].available, false);
  assert.match(status.appConfig.reason, /not listed/);
  await api.saveAiConfig({ model: 'installed' });
  assert.equal((await api.getDirectAiStatus()).providers[0].available, true);
  const offline = await loadBackgroundApi({ localData, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await offline.getDirectAiStatus()).providers[0].available, false);
});

test('AI transport times out and cancels while reading the response body', async () => {
  const api = await loadBackgroundApi({ fetchImpl: async (_url, init) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  }) });
  await assert.rejects(api.fetchAiResource('http://127.0.0.1:11434/api/chat', {}, { timeoutMs: 15 }), /timed out/);
  const controller = new AbortController();
  const pending = api.fetchAiResource('http://127.0.0.1:11434/api/chat', {}, { signal: controller.signal });
  controller.abort(new Error('Cancelled by teacher'));
  await assert.rejects(pending, /Cancelled by teacher/);
});

test('images use native provider schemas and text evidence is not silently truncated', async () => {
  const files = [{ textContent: 'x'.repeat(13000), images: [{ mimeType: 'image/png', base64Data: 'image-data' }] }];
  const api = await loadBackgroundApi();
  const ollama = api.createDirectMessages(sampleAssignment(), files);
  assert.equal(ollama[1].images[0], 'image-data');
  assert.ok(ollama[1].content.includes('x'.repeat(13000)));
  const compatible = api.createDirectMessages(sampleAssignment(), files, '', 'openai-compatible');
  assert.equal(compatible[1].content[1].image_url.url, 'data:image/png;base64,image-data');
  await assert.rejects(api.prepareDirectAttachments([{ textContent: 'x'.repeat(60001) }]), /text character/);
  assert.throws(() => api.normalizeExtraFileAttachments([{ sizeBytes: 5 * 1024 * 1024 }]), /exceed/);
});

test('an incomplete correction is rejected after repair instead of applying fallback grades', async () => {
  let requests = 0;
  const api = await loadBackgroundApi({
    localData: { 'mca.aiConfig': { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'test-model' } },
    fetchImpl: async () => { requests++; return Response.json({ message: { content: 'Invalid correction' } }); },
  });
  await assert.rejects(api.requestDirectAiCorrection(sampleAssignment()), /incomplete correction/);
  assert.equal(requests, 2);
});

test('missing rubric evidence and null scores are never treated as a complete AI correction', async () => {
  const api = await loadBackgroundApi();
  const assignment = sampleAssignment();
  const missing = api.parseCorrectionResponse('{"finalComment":"Reviewed","score":8,"rubricSelections":[]}', assignment);
  assert.equal(api.isCorrectionComplete(missing, assignment), false);
  const nullGrade = api.parseCorrectionResponse('{"finalComment":"Reviewed","score":null}', { ...assignment, rubric: [] });
  assert.equal(nullGrade.score, null);
  assert.equal(api.isCorrectionComplete(nullGrade, { ...assignment, rubric: [] }), false);
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

async function loadBackgroundApi({ fetchImpl = fetch, localData = {}, sessionData = {} } = {}) {
  const source = await fs.readFile(path.join(root, 'extension', 'src', 'background.js'), 'utf8');
  const event = { addListener() {} };
  const chrome = {
    action: { enable() {}, disable() {}, setTitle() {} },
    management: { getAll(callback) { callback([]); } },
    runtime: { lastError: null, onMessage: event, connect() { throw new Error('Not available in unit tests.'); } },
    storage: {
      local: { async get(key) { return { [key]: localData[key] }; }, async set(value) { Object.assign(localData, value); } },
      session: { async get(key) { return { [key]: sessionData[key] }; }, async set(value) { Object.assign(sessionData, value); } },
    },
    tabs: {
      create(_options, callback) { callback?.({ id: 1 }); },
      get(_tabId, callback) { callback({ id: 1, url: '' }); },
      onActivated: event,
      onUpdated: event,
      query(_options, callback) { callback([]); }
    }
  };
  const sandbox = { AbortController, Buffer, URL, chrome, clearTimeout, clearInterval, console, crypto, fetch: fetchImpl, setTimeout, setInterval };
  sandbox.globalThis = sandbox;
  const exports = [
    'buildCorrectionPrompt',
    'createDirectChatRequest',
    'isCorrectionComplete',
    'isSupportedGraderUrl',
    'normalizeMoodleAttachmentUrl',
    'parseCorrectionResponse',
    'requestDirectChat',
    'sanitizeAiConfig', 'saveAiConfig', 'loadBoundAiSecret', 'getDirectAiStatus', 'createDirectMessages',
    'prepareDirectAttachments', 'fetchAiResource', 'requestDirectAiCorrection', 'normalizeExtraFileAttachments'
  ].join(',');
  vm.runInNewContext(`${source}\nglobalThis.__testApi = {${exports}};`, sandbox, { filename: 'background.js' });
  return sandbox.__testApi;
}
