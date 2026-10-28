// Opt-in local inference using fictional PDF evidence only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { makePdf } from './fixtures/pdf.mjs';

const model = process.env.MCA_LIVE_MODEL || 'gemma4:e4b';
const baseUrl = 'http://127.0.0.1:11434';
const contextLength = 131072;
const operationTimeoutMs = Number(process.env.MCA_LIVE_TIMEOUT_MS || 360000);
assert.ok(Number.isInteger(operationTimeoutMs) && operationTimeoutMs >= 1000 && operationTimeoutMs <= 1800000, 'MCA_LIVE_TIMEOUT_MS must be between 1000 and 1800000.');
const models = await (await fetch(`${baseUrl}/api/tags`)).json();
assert.ok(models.models?.some(entry => entry.name === model), `Model must already be installed: ${model}`);
const extensionPath = path.resolve('extension');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const requests = [];
const modelResponses = [];
let closing = false;
try {
  const pdf = makePdf(true, 9);
  const fixtureOrigin = 'https://fictional-pdf-corrector.test';
  await context.route(`${fixtureOrigin}/**`, route => route.fulfill({ contentType: 'application/pdf', body: pdf }));
  // Override this diagnostic's requests only; do not change Ollama settings.
  await context.route(`${baseUrl}/api/chat`, async route => {
    try {
      const body = route.request().postDataJSON();
      body.options = { ...body.options, num_ctx: contextLength };
      requests.push(body);
      console.error(`Local fictional PDF check: request ${requests.length}, ${body.format === 'json' ? 'evidence review' : 'correction schema'}.`);
      // Playwright's replay bypasses the extension's scoped Origin-removal rule.
      const headers = { ...route.request().headers() };
      delete headers.origin;
      const response = await route.fetch({ headers, postData: JSON.stringify(body), timeout: Math.min(operationTimeoutMs, 900000) });
      const responseText = await response.text();
      const events = responseText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      modelResponses.push(events.map(event => event.message?.content || '').join(''));
      await route.fulfill({ response, body: responseText });
    } catch (error) {
      if (!closing) {
        console.error(`Local fictional PDF transport failed: ${error.message}`);
        await route.abort().catch(() => {});
      }
    }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const started = Date.now();
  const response = await page.evaluate(async ({ baseUrl, model, fixtureOrigin, operationTimeoutMs }) => {
    await MoodliaCorrectorRuntime.send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model } });
    const requestId = 'live-fictional-pdf-receipt';
    const timer = setTimeout(() => { void MoodliaCorrectorRuntime.send({ type: 'mca.cancelCorrection', requestId }); }, operationTimeoutMs);
    try {
      return await MoodliaCorrectorRuntime.send({ type: 'mca.correctAssignment', requestId, assignmentData: {
        page: { language: 'en', url: `${fixtureOrigin}/mod/assign/view.php?action=grader` },
        assignmentTitle: 'Fictional PDF receipt diagnostic',
        assignmentPrompt: 'Submit a nine-page PDF containing the sentence Fictional PDF evidence. Award full credit if both the text and nine-page requirements are met, using both Moodle rubric criteria.',
        maxScore: 10, gradingControls: { grade: { id: 'grade' } },
        rubric: [
          { id: 'pdf-text', description: 'The PDF contains the required sentence Fictional PDF evidence.', controls: { levelSelection: true },
            levels: [{ index: 0, score: 0, text: 'Required sentence absent.' }, { index: 1, score: 5, text: 'Required sentence present.' }] },
          { id: 'pdf-pages', description: 'The supplied PDF has nine pages.', controls: { levelSelection: true },
            levels: [{ index: 0, score: 0, text: 'Page count is not nine.' }, { index: 1, score: 5, text: 'Page count is nine.' }] },
        ],
        submissionFiles: [{ id: 'fictional-pdf', name: 'fictional.pdf', url: `${fixtureOrigin}/pluginfile.php/fictional.pdf` }],
      } });
    } finally { clearTimeout(timer); }
  }, { baseUrl, model, fixtureOrigin, operationTimeoutMs });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.correction.parsed.score, 10);
  assert.deepEqual(response.correction.parsed.rubricSelections.map(selection => [selection.criterionId, selection.levelIndex]), [['pdf-text', 1], ['pdf-pages', 1]]);
  assert.ok(requests.length >= 4, 'Expected three PDF block reviews and synthesis');
  const feedback = response.correction.parsed.studentFeedback;
  // Word boundaries: "diagnostic" must not count as "no".
  assert.doesNotMatch(feedback, /\b(?:no|not|missing|without|unavailable)\b.{0,35}(?:pdf|document|attachment)|(?:pdf|document|attachment).{0,35}(?:not provided|not supplied|not sent|missing)/i);
  const finalRequest = requests.at(-1);
  assert.equal(finalRequest.format.type, 'object');
  assert.equal(finalRequest.truncate, false);
  assert.equal(finalRequest.format.properties.score.maximum, 10);
  for (const [index, request] of requests.slice(0, 3).entries()) {
    assert.equal(request.format, 'json');
    assert.doesNotMatch(request.messages[1].content, /Required JSON shape:|score may be numeric/);
    assert.ok(JSON.parse(modelResponses[index]).observations?.length, 'Expected structured evidence observations');
  }
  assert.equal(finalRequest.messages[1].images, undefined);
  const receipt = JSON.parse(finalRequest.messages[0].content.split('\n').find(line => line.startsWith('{"attachmentEvidence":'))).attachmentEvidence;
  assert.equal(receipt[0].role, 'student-submission');
  assert.equal(receipt[0].documentFormat, 'pdf');
  assert.equal(receipt[0].pageCount, 9);
  console.log(JSON.stringify({ model, contextLength, elapsedMs: Date.now() - started,
    pages: 9, requests: requests.length, score: response.correction.parsed.score, feedback,
    originalRole: receipt[0].role, originalImagesInSynthesis: 0, rubricCriteria: response.correction.parsed.rubricSelections.length, usage: response.correction.usage }));
} finally {
  closing = true;
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}
