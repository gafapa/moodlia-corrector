import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { zipSync, strToU8 } from 'fflate';

const extensionPath = path.resolve('extension');
let lastChat;
let hang = false;
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/origin-check') { response.end(JSON.stringify({ origin: request.headers.origin || null })); return; }
  if (request.headers.origin && request.url.startsWith('/api/')) { response.statusCode = 403; response.end('{}'); return; }
  if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'fictional-vision' }] }));
  else if (request.url === '/api/show') response.end(JSON.stringify({ capabilities: ['completion', 'vision'] }));
  else if (request.url === '/api/chat') {
    lastChat = JSON.parse(body);
    if (hang) return;
    const content = lastChat.messages[0]?.content.includes('Connection test') ? '{"status":"ok"}'
      : JSON.stringify({ finalComment: 'Fictional work reviewed.', score: 8, rubricSelections: [] });
    response.end(JSON.stringify({ message: { content } }));
  } else { response.statusCode = 404; response.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const send = (message) => page.evaluate((value) => chrome.runtime.sendMessage(value), message);
  await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model: 'fictional-vision' } });
  const status = await send({ type: 'mca.getAiRuntimeStatus' });
  assert.equal(status.status.providers[0].available, true);
  assert.equal((await send({ type: 'mca.testAiConnection' })).ok, true);
  console.log('PASS: real Chromium extension loads, checks a loopback server, and verifies generation.');
  const webPage = await context.newPage();
  await webPage.goto(baseUrl);
  const websiteHeaders = await webPage.evaluate(async () => (await fetch('/origin-check', { method: 'POST', body: 'fictional' })).json());
  assert.equal(websiteHeaders.origin, baseUrl);
  await webPage.close();
  console.log('PASS: the local Origin workaround leaves website requests untouched.');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Server connected'));
  await page.locator('#test-connection').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Generation verified'));
  assert.equal(await page.locator('#cancel-test').isVisible(), false);
  console.log('PASS: the options page verifies generation and restores its controls.');

  const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Fictional DOCX evidence</w:t></w:r></w:p></w:body></w:document>') });
  const pdf = makePdf();
  const attachments = [
    { name: 'fictional.docx', mimeType: 'application/octet-stream', sizeBytes: docx.length, base64Data: Buffer.from(docx).toString('base64') },
    { name: 'fictional.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length, base64Data: pdf.toString('base64') },
    { name: 'fictional.png', mimeType: 'image/png', sizeBytes: 68, base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
  ];
  const result = await send({ type: 'mca.correctAssignment', requestId: 'attachments', assignmentData: {
    page: { language: 'en' }, assignmentTitle: 'Fictional task', assignmentPrompt: 'Review the attached evidence.',
    gradingControls: { grade: { id: 'grade' } }, maxScore: 10, extraFiles: attachments,
  } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.correction.parsed.score, 8);
  assert.match(lastChat.messages[1].content, /Fictional DOCX evidence/);
  assert.match(lastChat.messages[1].content, /Fictional PDF evidence/);
  assert.equal(lastChat.messages[1].images.length, 1);
  assert.doesNotMatch(lastChat.messages[1].content, /fictional\.docx|fictional\.pdf/);
  console.log('PASS: bundled offscreen reader extracts PDF and DOCX locally and sends image evidence.');
  const scannedPdf = makePdf(false);
  const scanned = await send({ type: 'mca.correctAssignment', requestId: 'scanned', assignmentData: {
    extraFiles: [{ name: 'fictional-scan.pdf', mimeType: 'application/pdf', sizeBytes: scannedPdf.length, base64Data: scannedPdf.toString('base64') }],
  } });
  assert.equal(scanned.ok, true, scanned.error);
  assert.equal(lastChat.messages[1].images.length, 1);
  console.log('PASS: PDF pages without a text layer are rendered locally for a vision model.');

  const unsupported = await send({ type: 'mca.correctAssignment', requestId: 'unsupported', assignmentData: {
    extraFiles: [{ name: 'archive.zip', base64Data: 'AA==', sizeBytes: 1 }],
  } });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /Unsupported attachment/);
  console.log('PASS: unsupported evidence stops grading.');

  const fixtureOrigin = 'https://moodle-corrector.test';
  const fixturePath = '/school/moodle/mod/assign/view.php?id=42';
  const templatePath = '/school/moodle/pluginfile.php/100/mod_assign/intro/template%20worksheet.odt';
  let templateDownloads = 0;
  await context.route(`${fixtureOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/pluginfile.php/')) {
      templateDownloads++;
      await route.abort();
      return;
    }
    const header = '<div class="page-header-headings"><h1>Fictional course name</h1></div>';
    const taskLink = `<a href="${fixturePath}">Tarea: Fictional task title</a>`;
    const body = url.searchParams.get('action') === 'grader'
      ? `${header}<div data-region="assignment-info">${taskLink}<a href="${fixturePath}&action=grading">View all submissions</a></div>
         <div class="assignsubmission_file"><a href="/school/moodle/pluginfile.php/200/assignsubmission_file/submission_files/fictional.txt">fictional.txt</a>
         <a href="/school/moodle/pluginfile.php/200/assignsubmission_file/submission_files/fictional.txt">fictional.txt</a></div>
         <div data-region="grade"><input name="grade" max="10"><textarea name="assignfeedbackcomments_editor[text]"></textarea></div>`
      : `${header}<nav class="breadcrumb">${taskLink}</nav><div class="activity-header"><h2>Fictional task title</h2></div>
         <div id="intro" class="activity-description"><p>Use the editable worksheet to complete this task.</p>
         <a href="${templatePath}">Download the editable worksheet</a><a href="${templatePath}?forcedownload=1">Download again</a>
         <a href="http://[broken">Invalid link</a><a href="https://example.test/help">Help website</a></div>`;
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><body>${body}</body></html>` });
  });
  const fixturePage = await context.newPage();
  await fixturePage.goto(`${fixtureOrigin}${fixturePath}&action=grader&userid=1`);
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  const extracted = await page.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.extractAssignment' });
  }, `${fixtureOrigin}${fixturePath}&action=grader&userid=1`);
  assert.equal(extracted.ok, true, extracted.error);
  const detected = extracted.assignmentData;
  assert.equal(detected.assignmentTitle, 'Fictional task title');
  assert.match(detected.assignmentPrompt, /Use the editable worksheet/);
  assert.equal(detected.assignmentFiles.length, 1);
  assert.equal(detected.assignmentFiles[0].name, 'template worksheet.odt');
  assert.match(detected.assignmentFiles[0].typeDescription, /ODT/);
  assert.equal(detected.assignmentFiles[0].contentRead, false);
  assert.equal(detected.submissionFiles.length, 1);
  assert.equal(templateDownloads, 0);
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-assignment-files]')?.textContent.includes('template worksheet.odt'));
  const capturedFiles = await fixturePage.locator('#mca-side-panel-host [data-assignment-files]').textContent();
  assert.match(capturedFiles, /Download the editable worksheet/);
  assert.match(capturedFiles, /no se ha leído/);
  console.log('PASS: supervision detects the task title and describes reference files separately from submissions without downloading them.');
  await fixturePage.close();

  hang = true;
  const pending = send({ type: 'mca.correctAssignment', requestId: 'cancel-test', assignmentData: { assignmentPrompt: 'Fictional cancellation test.' } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const cancelled = await send({ type: 'mca.cancelCorrection', requestId: 'cancel-test' });
  assert.equal(cancelled.cancelled, true);
  const interrupted = await pending;
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.error, /cancelled/);
  console.log('PASS: teacher cancellation aborts a pending provider request.');
  await page.locator('#test-connection').click();
  await page.locator('#cancel-test').waitFor({ state: 'visible' });
  await page.locator('#cancel-test').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('cancelled'));
  console.log('PASS: the options page can cancel its connection test.');
  hang = false;

  if (process.argv.includes('--live')) {
    await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b' } });
    const live = await send({ type: 'mca.testAiConnection' });
    assert.equal(live.ok, true, live.error);
    console.log(`PASS: actual local Ollama generation from Chromium (${live.result.model}, ${live.result.elapsedMs} ms).`);
    const liveCorrection = await send({ type: 'mca.correctAssignment', requestId: 'live-fictional', assignmentData: {
      page: { language: 'en' }, assignmentTitle: 'Fictional arithmetic task', assignmentPrompt: 'Verify that 2 + 2 = 4. Award 10 points if correct, 0 otherwise.',
      maxScore: 10, gradingControls: { grade: { id: 'grade' } },
      extraFiles: [{ name: 'fictional-answer.txt', mimeType: 'text/plain', sizeBytes: 9, textContent: '2 + 2 = 4' }],
      rubric: [{ id: 'calculation', description: 'Correct arithmetic', controls: { levelSelection: true },
        levels: [{ index: 0, score: 0, text: 'Incorrect' }, { index: 1, score: 10, text: 'Correct' }] }],
    } });
    assert.equal(liveCorrection.ok, true, liveCorrection.error);
    assert.equal(liveCorrection.correction.parsed.score, 10);
    assert.equal(liveCorrection.correction.parsed.rubricSelections[0].levelIndex, 1);
    console.log('PASS: actual local Ollama returns a complete fictional grade, feedback, and rubric selection.');
  }
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function makePdf(withText = true) {
  const content = withText ? 'BT /F1 16 Tf 30 100 Td (Fictional PDF evidence) Tj ET' : '0 0 1 rg 30 30 60 60 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
