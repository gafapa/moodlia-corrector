// Opt-in local inference using fictional DOCX and ODT evidence only.
// Each document has a text-only first page (sent as text) and a second page with
// a table and a red image (sent as a page image), plus white text a reader cannot
// see, which must never reach the model.
import assert from 'node:assert/strict';
import path from 'node:path';
import { HIDDEN, docx, odt } from './fixtures/office-answer.mjs';
import { chromium } from 'playwright';

const model = process.env.MCA_LIVE_MODEL || 'gemma4:e4b';
const baseUrl = 'http://127.0.0.1:11434';
// MCA_LIVE_EXTENSION_CONTEXT=1 keeps the context size the extension chooses instead of 131,072.
const contextLength = process.env.MCA_LIVE_EXTENSION_CONTEXT === '1' ? null : 131072;
const operationTimeoutMs = Number(process.env.MCA_LIVE_TIMEOUT_MS || 600000);
assert.ok(Number.isInteger(operationTimeoutMs) && operationTimeoutMs >= 1000 && operationTimeoutMs <= 1800000, 'MCA_LIVE_TIMEOUT_MS must be between 1000 and 1800000.');
const models = await (await fetch(`${baseUrl}/api/tags`)).json();
assert.ok(models.models?.some(entry => entry.name === model), `Model must already be installed: ${model}`);

const extensionPath = path.resolve('extension');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let requests = [];
const contexts = [];
let closing = false;
const results = [];
try {
  const fixtureOrigin = 'https://fictional-office-corrector.test';
  const files = { 'answer.docx': docx(), 'answer.odt': odt() };
  await context.route(`${fixtureOrigin}/**`, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ contentType: name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.oasis.opendocument.text', body: Buffer.from(files[name]) });
  });
  // Override this diagnostic's requests only; do not change Ollama settings.
  await context.route(`${baseUrl}/api/chat`, async route => {
    try {
      const body = route.request().postDataJSON();
      if (contextLength) body.options = { ...body.options, num_ctx: contextLength };
      contexts.push(body.options?.num_ctx ?? null);
      requests.push(body);
      const headers = { ...route.request().headers() };
      delete headers.origin;
      const response = await route.fetch({ headers, postData: JSON.stringify(body), timeout: Math.min(operationTimeoutMs, 900000) });
      await route.fulfill({ response, body: await response.text() });
    } catch (error) {
      if (!closing) {
        console.error(`Local fictional document transport failed: ${error.message}`);
        await route.abort().catch(() => {});
      }
    }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  for (const name of Object.keys(files)) {
    requests = [];
    const started = Date.now();
    const response = await page.evaluate(async ({ baseUrl, model, fixtureOrigin, operationTimeoutMs, name }) => {
      await MoodliaCorrectorRuntime.send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model } });
      const requestId = `live-fictional-${name}`;
      const timer = setTimeout(() => { void MoodliaCorrectorRuntime.send({ type: 'mca.cancelCorrection', requestId }); }, operationTimeoutMs);
      try {
        return await MoodliaCorrectorRuntime.send({ type: 'mca.correctAssignment', requestId, assignmentData: {
          page: { language: 'en', url: `${fixtureOrigin}/mod/assign/view.php?action=grader` },
          assignmentTitle: 'Fictional geography diagnostic',
          assignmentPrompt: 'Write the capital of the fictional country of Veloria, a population table with its total, and include the flag of Veloria, which is a solid red square. Award each rubric criterion only when the submitted document shows it.',
          maxScore: 10, gradingControls: { grade: { id: 'grade' } },
          rubric: [
            { id: 'capital', description: 'The document states that the capital is Brannock.', controls: { levelSelection: true },
              levels: [{ index: 0, score: 0, text: 'Capital missing or wrong.' }, { index: 1, score: 4, text: 'Capital is Brannock.' }] },
            { id: 'total', description: 'The population table gives a total of 42 thousand.', controls: { levelSelection: true },
              levels: [{ index: 0, score: 0, text: 'Total missing or wrong.' }, { index: 1, score: 3, text: 'Total is 42.' }] },
            { id: 'flag', description: 'The document includes the flag as a red square image.', controls: { levelSelection: true },
              levels: [{ index: 0, score: 0, text: 'No red flag image.' }, { index: 1, score: 3, text: 'Red flag image present.' }] },
          ],
          submissionFiles: [{ id: name, name, url: `${fixtureOrigin}/pluginfile.php/1/assignsubmission_file/submission_files/1/${name}` }],
        } });
      } finally { clearTimeout(timer); }
    }, { baseUrl, model, fixtureOrigin, operationTimeoutMs, name });
    assert.equal(response.ok, true, response.error);
    const everything = JSON.stringify(requests);
    assert.ok(!everything.includes(HIDDEN), `${name}: invisible text reached the model`);
    const first = requests[0];
    const evidence = JSON.parse(first.messages[1].content.split('Attached evidence JSON:\n')[1]).attachments[0];
    assert.match(evidence.textContent, /Page 1: text only/);
    assert.match(evidence.textContent, /1\. Brannock lies on the river Tessel\./);
    assert.deepEqual(evidence.imagePages, [2]);
    assert.equal(first.messages[1].images.length, 1);
    const receipt = JSON.parse(first.messages[0].content.split('\n').find(line => line.startsWith('{"attachmentEvidence":'))).attachmentEvidence;
    assert.ok(receipt[0].omittedImages?.some(entry => entry.reason === 'invisible-text-excluded'), `${name}: receipt reports the invisible text`);
    const selections = Object.fromEntries(response.correction.parsed.rubricSelections.map(selection => [selection.criterionId, selection.levelIndex]));
    results.push({ name, elapsedMs: Date.now() - started, requests: requests.length, score: response.correction.parsed.score, selections,
      usage: response.correction.usage, feedback: response.correction.parsed.studentFeedback });
    assert.deepEqual(selections, { capital: 1, total: 1, flag: 1 }, `${name}: ${JSON.stringify(response.correction.parsed)}`);
    assert.equal(response.correction.parsed.score, 10);
  }
  console.log(JSON.stringify({ model, contextLength, requestContexts: contexts, results }));
} finally {
  if (results.length) console.error(JSON.stringify(results));
  closing = true;
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}
