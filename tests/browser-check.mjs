import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { zipSync, strToU8 } from 'fflate';

const extensionPath = path.resolve('extension');
let lastChat;
let hang = false;
let chatDelayMs = 0;
let onChat;
let compatibleAuthorization = '';
let compatibleModels = [{ id: 'fictional-vision' }];
let ollamaModels = [{ name: 'fictional-vision' }];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/origin-check') { response.end(JSON.stringify({ origin: request.headers.origin || null })); return; }
  if (request.headers.origin && request.url.startsWith('/api/')) { response.statusCode = 403; response.end('{}'); return; }
  if (request.url.startsWith('/v1/')) {
    compatibleAuthorization = request.headers.authorization || '';
    if (request.headers.origin) { response.statusCode = 403; response.end('{}'); return; }
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: compatibleModels })); return; }
    if (request.url === '/v1/chat/completions') {
      lastChat = JSON.parse(body);
      const content = lastChat.messages[0]?.content.includes('Connection test') ? '{"status":"ok"}'
        : JSON.stringify({ studentFeedback: 'Fictional local compatible review.', score: 8, rubricSelections: [] });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
  }
  if (request.url === '/api/tags') response.end(JSON.stringify({ models: ollamaModels }));
  else if (request.url === '/api/show') response.end(JSON.stringify({ capabilities: ['completion', 'vision'] }));
  else if (request.url === '/api/chat') {
    lastChat = JSON.parse(body);
    onChat?.();
    if (hang) return;
    if (chatDelayMs) await new Promise((resolve) => setTimeout(resolve, chatDelayMs));
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
context.setDefaultTimeout(15000);
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  await worker.evaluate(() => chrome.storage.local.set({ 'mca.uiLanguage': 'en' }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  page.on('pageerror', error => console.error('Options page error:', error.message));
  const send = (message) => page.evaluate((value) => MoodliaCorrectorRuntime.send(value), message);
  await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model: 'fictional-vision' } });
  const status = await send({ type: 'mca.getAiRuntimeStatus' });
  assert.equal(status.status.providers[0].available, true);
  assert.equal((await send({ type: 'mca.testAiConnection' })).ok, true);
  console.log('PASS: real Chromium extension loads, checks a loopback server, and verifies generation.');
  await page.locator('#provider').selectOption('lm-studio');
  assert.equal(await page.locator('#baseUrl').inputValue(), 'http://127.0.0.1:1234/v1');
  assert.equal(await page.locator('#apiKey').evaluate(element => element.required), false);
  await page.locator('#baseUrl').fill(`${baseUrl}/v1`);
  await page.locator('#load-models').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('model(s) found'));
  assert.equal(await page.locator('#model').inputValue(), 'fictional-vision');
  assert.equal(await page.locator('#available-models option').count(), 1);
  await page.locator('#test-connection').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Generation verified: lm-studio'));
  assert.equal(compatibleAuthorization, '');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Server connected'));
  assert.equal(await page.locator('#provider').inputValue(), 'lm-studio');
  assert.equal(await page.locator('#baseUrl').inputValue(), `${baseUrl}/v1`);
  console.log('PASS: LM Studio selects its endpoint, discovers models, generates without a key, and restores saved settings.');
  const studioImage = await send({ type: 'mca.correctAssignment', assignmentData: {
    maxScore: 10, gradingControls: { grade: { id: 'grade' } },
    extraFiles: [{ name: 'fictional.png', mimeType: 'image/png', sizeBytes: 68, base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }],
  } });
  assert.equal(studioImage.ok, true, studioImage.error);
  assert.equal(studioImage.correction.provider, 'lm-studio');
  assert.equal(lastChat.messages[1].content[1].type, 'image_url');
  assert.equal(lastChat.messages[1].images, undefined);
  await send({ type: 'mca.setAiRuntimeConfig', config: { apiKey: 'fictional-studio-token' } });
  assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.hasApiKey, true);
  assert.equal(compatibleAuthorization, 'Bearer fictional-studio-token');
  console.log('PASS: LM Studio sends image evidence using compatible content parts and supports optional authentication.');
  await page.locator('#provider').selectOption('local-compatible');
  assert.equal(await page.locator('#baseUrl').inputValue(), 'http://127.0.0.1:8080/v1');
  await page.locator('#baseUrl').fill(`${baseUrl}/v1`);
  compatibleModels = [];
  await page.locator('#load-models').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('returned no models'));
  assert.equal(compatibleAuthorization, '');
  compatibleModels = [{ id: 'fictional-vision' }];
  await page.locator('#load-models').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('model(s) found'));
  await page.locator('#test-connection').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Generation verified: local-compatible'));
  console.log('PASS: another local compatible server reports empty models, discovers available models, and generates without inheriting the LM Studio key.');
  await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model: 'fictional-vision' } });
  for (const [id, port] of [['ollama', '11434'], ['lm-studio', '1234'], ['llama-cpp', '8080'], ['localai', '8080'], ['vllm', '8000'], ['openai-compatible', '443']]) {
    await page.locator('#provider').selectOption(id);
    assert.equal(await page.locator('#endpointPort').isVisible(), true);
    assert.equal(await page.locator('#endpointHost').isVisible(), true);
    if (['llama-cpp', 'localai', 'vllm', 'openai-compatible'].includes(id)) assert.equal(await page.locator('#endpointPort').inputValue(), port);
    await page.locator('#endpointHost').fill('192.168.1.20');
    await page.locator('#endpointPort').fill('15432');
    assert.equal(new URL(await page.locator('#baseUrl').inputValue()).hostname, '192.168.1.20');
    assert.equal(new URL(await page.locator('#baseUrl').inputValue()).port, '15432');
    await page.locator('#endpointProtocol').selectOption('https:');
    await page.locator('#endpointHost').fill('2001:db8::20');
    assert.equal(new URL(await page.locator('#baseUrl').inputValue()).hostname, '[2001:db8::20]');
  }
  console.log('PASS: every named provider exposes synchronized IP, IPv6, protocol, port, and API path fields.');
  for (const id of ['llama-cpp', 'localai', 'vllm']) {
    await page.locator('#provider').selectOption(id);
    await page.locator('#baseUrl').fill(`${baseUrl}/v1`);
    await page.locator('#load-models').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('model(s) found'));
    await page.locator('#test-connection').click();
    await page.waitForFunction((provider) => document.querySelector('#status').textContent.includes(`Generation verified: ${provider}`), id);
    assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.provider, id);
  }
  console.log('PASS: llama.cpp, LocalAI, and vLLM each discover models and generate using their own named configuration.');
  const savedBeforeDeniedAccess = await page.evaluate(async () => (await chrome.storage.local.get('mca.aiConfig'))['mca.aiConfig']);
  await page.locator('#provider').selectOption('localai');
  await page.locator('#baseUrl').fill('http://192.168.1.20:9000/v1');
  await page.evaluate(() => { window.requestedServerHosts = []; chrome.permissions.request = async (value) => { window.requestedServerHosts.push(...value.origins); return false; }; });
  await page.locator('#load-models').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Server access was not granted'));
  assert.deepEqual(await page.evaluate(() => window.requestedServerHosts), ['http://192.168.1.20/*']);
  assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get('mca.aiConfig'))['mca.aiConfig']), savedBeforeDeniedAccess);
  console.log('PASS: LAN HTTP asks for the selected host only and denied access preserves the saved configuration.');
  await page.locator('#baseUrl').fill(`${baseUrl}/v1`);
  await page.locator('#model').fill('fictional-vision');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Connection saved'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Server connected'));
  await page.locator('#provider').selectOption('vllm');
  assert.equal(await page.locator('#baseUrl').inputValue(), `${baseUrl}/v1`);
  await page.locator('#provider').selectOption('localai');
  assert.equal(await page.locator('#baseUrl').inputValue(), `${baseUrl}/v1`);
  await page.locator('#endpointPort').fill('65536');
  assert.equal(await page.locator('#endpointPort').evaluate(element => element.checkValidity()), false);
  await page.locator('#baseUrl').fill(`${baseUrl}/v1`);
  console.log('PASS: provider-specific addresses and models survive reopening, and ports above 65535 are invalid.');
  compatibleModels = [
    { id: 'zebra-model', display_name: 'Zebra Vision', size: 4 * 1024 ** 3, details: { parameter_size: '8B', quantization_level: 'Q8' } },
    { id: 'fictional-vision', display_name: 'Alpha Vision', details: { parameter_size: '4B', quantization_level: 'Q4_K_M' } },
    { id: 'fictional-vision', display_name: 'Duplicate model' },
  ];
  await page.locator('#load-models').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('2 model(s) found'));
  assert.match(await page.locator('#available-models option').first().textContent(), /Alpha Vision.*4B.*Q4_K_M/);
  assert.match(await page.locator('#available-models option').last().textContent(), /Zebra Vision.*8B.*Q8.*4.0 GiB/);
  await page.locator('#modelSearch').fill('q8');
  assert.equal(await page.locator('#available-models option').count(), 1);
  await page.locator('#available-models').selectOption('zebra-model');
  assert.equal(await page.locator('#model').inputValue(), 'zebra-model');
  await page.locator('#modelSearch').fill('no-such-model');
  assert.equal(await page.locator('#available-models').isDisabled(), true);
  assert.match(await page.locator('#model-count').textContent(), /No matches/);
  assert.equal(await page.locator('#model').inputValue(), 'zebra-model');
  await page.locator('#modelSearch').fill('');
  await page.locator('#available-models').focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#model').inputValue(), 'fictional-vision');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: `node_modules/review-models-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  compatibleModels = [{ id: 'fictional-vision' }];
  console.log('PASS: model lists sort readable names, show metadata, remove duplicate IDs, filter, support keyboard selection, and fit desktop/mobile.');
  await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl, model: 'fictional-vision' } });
  const webPage = await context.newPage();
  await webPage.goto(baseUrl);
  const websiteHeaders = await webPage.evaluate(async () => (await fetch('/origin-check', { method: 'POST', body: 'fictional' })).json());
  assert.equal(websiteHeaders.origin, baseUrl);
  const closedTabId = await page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, webPage.url());
  await webPage.close();
  console.log('PASS: the local Origin workaround leaves website requests untouched.');
  const closedTabErrors = await worker.evaluate(async (tabId) => {
    const errors = [];
    const capture = (event) => errors.push(String(event.reason));
    self.addEventListener('unhandledrejection', capture);
    try {
      await updateActionForTab(tabId, 'https://moodle.example/mod/assign/view.php?action=grader');
      await updateActionForTab(tabId, 'https://moodle.example/course/view.php');
      await new Promise(resolve => setTimeout(resolve, 0));
      return errors;
    } finally { self.removeEventListener('unhandledrejection', capture); }
  }, closedTabId);
  assert.deepEqual(closedTabErrors, []);
  console.log('PASS: actual Chrome action updates for a closed tab finish without unhandled promise rejections.');
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
    ...[['c', 'int main(void) { return 0; }'], ['hpp', '#pragma once'], ['html', '<script>globalThis.codeMustStayInert = true;</script>'], ['mjs', 'export const answer = 42;']].map(([extension, text]) => ({ name: `source.${extension}`, mimeType: 'application/octet-stream', sizeBytes: Buffer.byteLength(text), base64Data: Buffer.from(text).toString('base64') })),
  ];
  const result = await send({ type: 'mca.correctAssignment', requestId: 'attachments', assignmentData: {
    page: { language: 'en' }, assignmentTitle: 'Fictional task', assignmentPrompt: 'Review the attached evidence.',
    gradingControls: { grade: { id: 'grade' } }, maxScore: 10, extraFiles: attachments,
  } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.correction.parsed.score, 8);
  assert.match(lastChat.messages[1].content, /Fictional DOCX evidence/);
  assert.match(lastChat.messages[1].content, /Fictional PDF evidence/);
  assert.equal(lastChat.messages[1].images.length, 2);
  assert.doesNotMatch(lastChat.messages[1].content, /fictional\.docx|fictional\.pdf/);
  console.log('PASS: bundled offscreen reader extracts PDF and DOCX locally and sends image evidence.');
  for (const snippet of ['int main(void)', '#pragma once', 'globalThis.codeMustStayInert = true;', 'export const answer = 42;']) assert.ok(lastChat.messages[1].content.includes(snippet));
  assert.equal(await page.evaluate(() => globalThis.codeMustStayInert), undefined);
  assert.equal(await worker.evaluate(() => globalThis.codeMustStayInert), undefined);
  console.log('PASS: C, C++ headers, HTML and JavaScript modules reach the provider as literal source text without execution.');
  const scannedPdf = makePdf(false);
  const scanned = await send({ type: 'mca.correctAssignment', requestId: 'scanned', assignmentData: {
    extraFiles: [{ name: 'fictional-scan.pdf', mimeType: 'application/pdf', sizeBytes: scannedPdf.length, base64Data: scannedPdf.toString('base64') }],
  } });
  assert.equal(scanned.ok, true, scanned.error);
  assert.equal(lastChat.messages[1].images.length, 1);
  console.log('PASS: PDF pages without a text layer are rendered locally for a vision model.');
  const mixedPdf = makePdf('mixed');
  const mixed = await send({ type: 'mca.correctAssignment', requestId: 'mixed-pdf', assignmentData: {
    extraFiles: [{ name: 'fictional-chart.pdf', mimeType: 'application/pdf', sizeBytes: mixedPdf.length, base64Data: mixedPdf.toString('base64') }],
  } });
  assert.equal(mixed.ok, true, mixed.error);
  assert.match(lastChat.messages[1].content, /Fictional PDF evidence/);
  assert.equal(lastChat.messages[1].images.length, 1);
  console.log('PASS: PDF pages with both text and graphics retain both kinds of evidence.');
  const rasterPdf = makePdf('raster');
  const raster = await send({ type: 'mca.correctAssignment', requestId: 'raster-pdf', assignmentData: {
    extraFiles: [{ name: 'fictional-raster.pdf', mimeType: 'application/pdf', sizeBytes: rasterPdf.length, base64Data: rasterPdf.toString('base64') }],
  } });
  assert.equal(raster.ok, true, raster.error);
  assert.equal(lastChat.messages[1].images.length, 1);
  const rasterEvidence = JSON.parse(lastChat.messages[1].content.split('Attached evidence JSON:\n')[1]);
  assert.deepEqual(rasterEvidence.attachments[0].imagePages, [1]);
  const pixel = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return Array.from(ctx.getImageData(Math.round(image.width * 0.2), Math.round(image.height * 0.6), 1, 1).data);
  }, lastChat.messages[1].images[0]);
  assert.ok(pixel[0] > 240 && pixel[1] < 15 && pixel[2] < 15, `Embedded image pixels were lost: ${pixel}`);
  assert.match(lastChat.messages[0].content, /Inspect every supplied image/);
  console.log('PASS: an embedded PDF raster image reaches the provider with its page number and verified red pixels.');


  const unsupported = await send({ type: 'mca.correctAssignment', requestId: 'unsupported', assignmentData: {
    extraFiles: [{ name: 'archive.zip', base64Data: 'AA==', sizeBytes: 1 }],
  } });
  assert.equal(unsupported.ok, true, unsupported.error);
  assert.equal(unsupported.correction.skippedFiles.length, 1);
  assert.equal(unsupported.correction.skippedFiles[0].role, 'teacher-additional');
  assert.match(lastChat.messages[1].content, /unsupported-format/);
  assert.doesNotMatch(lastChat.messages[1].content, /archive\.zip/);
  console.log('PASS: unsupported evidence is omitted without blocking the remaining correction or exposing its filename.');
  const invalidOdt = zipSync({ 'content.xml': strToU8('<broken') });
  const chatBeforeInvalidOdt = lastChat;
  const invalidOdtResult = await send({ type: 'mca.correctAssignment', requestId: 'invalid-odt', assignmentData: {
    extraFiles: [{ name: 'broken.odt', sizeBytes: invalidOdt.length, base64Data: Buffer.from(invalidOdt).toString('base64') }],
  } });
  assert.equal(invalidOdtResult.ok, false);
  assert.match(invalidOdtResult.error, /Invalid ODT XML/);
  assert.equal(lastChat, chatBeforeInvalidOdt);
  console.log('PASS: malformed ODT evidence stops before contacting the AI provider.');

  const fixtureOrigin = 'https://moodle-corrector.test';
  const fixturePath = '/school/moodle/mod/assign/view.php?id=42';
  const templatePath = '/school/moodle/pluginfile.php/100/mod_assign/intro/template%20worksheet.odt';
  let templateDownloads = 0;
  const referenceOdt = zipSync({
    'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Fictional teacher reference requirements.</text:p></office:text></office:body></office:document-content>'),
    'Pictures/example.png': Buffer.from(attachments[2].base64Data, 'base64'),
  });
  await context.route(`${fixtureOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/pluginfile.php/')) {
      if (url.pathname.includes('/mod_assign/intro/')) {
        templateDownloads++;
        await route.fulfill({ contentType: 'application/vnd.oasis.opendocument.text', body: Buffer.from(referenceOdt) });
      } else await route.fulfill({ contentType: 'text/plain', body: 'Fictional student authored answer.' });
      return;
    }
    const header = '<div class="page-header-headings"><h1>Fictional course name</h1></div>';
    const taskLink = `<a href="${fixturePath}">Tarea: Fictional task title</a>`;
    const body = url.searchParams.get('action') === 'grader'
      ? `${header}<div data-region="assignment-info">${taskLink}<a href="${fixturePath}&action=grading">View all submissions</a></div>
         <div class="assignsubmission_onlinetext">${'a'.repeat(13000)} Online evidence end.</div>
         <div class="assignsubmission_file"><a href="/school/moodle/pluginfile.php/200/assignsubmission_file/submission_files/fictional.txt">fictional.txt</a>
         <a href="/school/moodle/pluginfile.php/200/assignsubmission_file/submission_files/fictional.txt">fictional.txt</a></div>
         <div data-region="grade"><label for="id_grade">Calificación sobre 10</label><input id="id_grade" name="grade" type="text"><textarea id="id_assignfeedbackcomments_editor" name="assignfeedbackcomments_editor[text]"></textarea><iframe id="id_assignfeedbackcomments_editor_ifr" srcdoc="<body contenteditable='true'></body>"></iframe></div>
         <div data-region="grading-navigation-panel">Fictional navigation</div>
         <div data-region="review-panel">Fictional document preview</div>
         <div data-region="grade-actions-panel">Fictional grading actions</div>
         <style>html,body{height:100%;margin:0} [data-region="grading-navigation-panel"]{position:absolute;top:0;left:0;right:0;height:60px;background:#eee} [data-region="review-panel"]{position:absolute;top:60px;bottom:60px;left:0;right:30%;overflow:auto;background:#fafafa} [data-region="grade"]{position:absolute;top:60px;bottom:60px;left:70%;right:0;overflow:auto} [data-region="grade-actions-panel"]{position:fixed;bottom:0;left:0;right:0;height:60px;background:#ddd}</style>`
      : `${header}<nav class="breadcrumb">${taskLink}</nav><div class="activity-header"><h2>Fictional task title</h2></div>
         <div id="intro" class="activity-description"><p>Use the editable worksheet to complete this task. ${'b'.repeat(13000)} Statement end.</p>
         <a href="${templatePath}">Download the editable worksheet</a><a href="${templatePath}?forcedownload=1">Download again</a>
         <a href="/school/moodle/pluginfile.php/100/mod_assign/intro/reference.zip">reference.zip</a>
         <a href="http://[broken">Invalid link</a><a href="https://example.test/help">Help website</a></div>`;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', headers: url.searchParams.get('action') === 'grader' ? { 'Content-Security-Policy': "frame-src 'self'; object-src 'none'" } : {}, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body class="course-7"><div id="page"><section class="embedded-main">${body}</section></div><style>#page { position: inherit; } .embedded-main::before { content: ''; display: block; height: 1px; }</style></body></html>` });
  });
  await context.route(`${fixtureOrigin}/redirect-evidence.txt`, (route) => route.fulfill({ status: 302, headers: { location: 'https://storage-corrector.test/signed.txt?signature=fictional' } }));
  await context.addCookies([{ name: 'storage-session', value: 'fictional', url: 'https://storage-corrector.test', secure: true, sameSite: 'None' }]);
  let storageCookie = '';
  await context.route('https://storage-corrector.test/**', (route) => {
    storageCookie = route.request().headers().cookie || '';
    return route.fulfill({ contentType: 'text/plain', body: 'Fictional redirected storage evidence.' });
  });
  const redirectedEvidence = await worker.evaluate(async (url) => {
    try { return { text: await (await fetchMoodleAttachment(url)).text() }; } catch (error) { return { error: error.message }; }
  }, `${fixtureOrigin}/redirect-evidence.txt`);
  assert.equal(redirectedEvidence.error, undefined, redirectedEvidence.error);
  assert.equal(redirectedEvidence.text, 'Fictional redirected storage evidence.');
  assert.equal(storageCookie, '');
  console.log('PASS: actual Chromium resolves an opaque Moodle redirect to signed HTTPS storage.');
  const unrelatedPage = await context.newPage();
  await unrelatedPage.goto(`${fixtureOrigin}/unrelated`);
  assert.equal(await unrelatedPage.evaluate(() => typeof MoodliaCorrectorAttachmentSupport), 'undefined');
  assert.equal(await unrelatedPage.locator('#mca-side-panel-host').count(), 0);
  await unrelatedPage.evaluate((url) => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, `chrome-extension://${extensionId}/src/options/options.html?embedded=1&token=forged`);
  await unrelatedPage.frameLocator('iframe').locator('body').filter({ hasText: 'Open advanced settings' }).waitFor();
  assert.equal(await unrelatedPage.frameLocator('iframe').locator('#apiKey').count(), 0);
  console.log('PASS: an unrelated page cannot embed the AI settings with a forged authorization token.');
  await unrelatedPage.close();
  console.log('PASS: content scripts are absent from unrelated HTTPS pages.');
  await worker.evaluate(() => chrome.storage.local.set({ 'mca.uiLanguage': 'es' }));
  const activationFiles = await worker.evaluate(() => MoodliaCorrectorActivation.contentScripts);
  const activatePage = (url) => page.evaluate(async ({ url, files }) => { const [tab] = await chrome.tabs.query({ url }); await chrome.scripting.executeScript({ target: { tabId: tab.id }, files }); }, { url, files: activationFiles });
  // Reproduce a persisted pre-localization registration before background synchronization repairs it.
  await worker.evaluate(async origin => {
    await chrome.scripting.registerContentScripts([{
      id: 'legacy-i18n-regression', matches: [`${origin}/school/moodle/mod/assign/view.php*`],
      js: ['src/aiProviders.js', 'src/attachmentSupport.js', 'src/correctionSchema.js', 'src/savedInstructions.js', 'src/filePreview.js', 'src/content/moodleContent.js'],
      runAt: 'document_idle', persistAcrossSessions: true,
    }]);
  }, fixtureOrigin);
  const legacyPage = await context.newPage();
  const legacyErrors = [];
  legacyPage.on('pageerror', error => legacyErrors.push(error.message));
  await legacyPage.goto(`${fixtureOrigin}${fixturePath}`);
  const overviewRuntime = await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => typeof globalThis.MoodliaCorrectorI18n });
    return result.result;
  }, legacyPage.url());
  assert.equal(overviewRuntime, 'undefined');
  assert.equal(await legacyPage.locator('#mca-side-panel-host').count(), 0);
  assert.deepEqual(legacyErrors, []);
  console.log('PASS: legacy automatic injection ignores an assignment overview without touching localization or creating an assistant.');
  await legacyPage.goto(`${fixtureOrigin}${fixturePath}&action=grader&userid=1`);
  await legacyPage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  const legacyLocale = await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.MoodliaCorrectorI18n.locale });
    return result.result;
  }, legacyPage.url());
  assert.equal(legacyLocale, 'es');
  assert.equal(await legacyPage.locator('#mca-side-panel-host').count(), 1);
  assert.deepEqual(legacyErrors, []);
  console.log('PASS: a persisted registration without localization dependencies opens the grader in the saved language without startup errors.');
  await worker.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['legacy-i18n-regression'] }));
  await legacyPage.close();
  const fixturePage = await context.newPage();
  await fixturePage.goto(`${fixtureOrigin}${fixturePath}&action=grader&userid=1`);
  assert.equal(await fixturePage.locator('#mca-side-panel-host').count(), 0);
  await page.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async (...args) => {
        if (args[0] === 'mca.uiLanguage') {
          await new Promise(resolve => setTimeout(resolve, 150));
          chrome.storage.local.get = originalGet;
        }
        return originalGet(...args);
      };
    } });
  }, fixturePage.url());
  await activatePage(fixturePage.url());
  assert.equal(await fixturePage.locator('#mca-side-panel-host').count(), 1);
  await activatePage(fixturePage.url());
  assert.equal(await fixturePage.locator('#mca-side-panel-host').count(), 1);
  console.log('PASS: a fresh grader has no automatic injection and repeated manual activation creates one assistant.');
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  const extracted = await page.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.extractAssignment' });
  }, `${fixtureOrigin}${fixturePath}&action=grader&userid=1`);
  assert.equal(extracted.ok, true, extracted.error);
  const detected = extracted.assignmentData;
  assert.equal(detected.assignmentTitle, 'Fictional task title');
  assert.equal(detected.correctionMethod, 'simple-direct');
  assert.equal(detected.maxScore, 10);
  assert.match(detected.assignmentPrompt, /Use the editable worksheet/);
  assert.match(detected.assignmentPrompt, /Statement end\./);
  assert.match(detected.submissionText, /Online evidence end\./);
  assert.equal(detected.assignmentFiles.length, 2);
  assert.equal(detected.assignmentFiles[0].name, 'template worksheet.odt');
  assert.match(detected.assignmentFiles[0].typeDescription, /ODT/);
  assert.equal(detected.assignmentFiles[0].contentRead, false);
  assert.equal(detected.submissionFiles.length, 1);
  assert.equal(templateDownloads, 0);
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-assignment-files]')?.textContent.includes('template worksheet.odt'));
  const capturedFiles = await fixturePage.locator('#mca-side-panel-host [data-assignment-files]').textContent();
  assert.match(capturedFiles, /Download the editable worksheet/);
  assert.match(capturedFiles, /no trabajo del alumno/);
  const filesToInclude = fixturePage.locator('#mca-side-panel-host [data-file-preview]');
  assert.match(await filesToInclude.locator('[data-file-role="assignment-reference"]').first().textContent(), /template worksheet\.odt/);
  assert.match(await filesToInclude.locator('[data-file-role="student-submission"]').textContent(), /fictional\.txt/);
  assert.match(await filesToInclude.locator('[data-file-role="assignment-reference"]').first().getAttribute('aria-label'), /no se evalúa como entrega/);
  assert.equal(await filesToInclude.locator('[data-file-role] p').count(), 0);
  const omittedReference = filesToInclude.locator('[data-file-status="skipped"]');
  assert.match(await omittedReference.textContent(), /reference\.zip.*Omitido.*Formato no soportado/s);
  assert.equal(await omittedReference.evaluate(element => getComputedStyle(element).color), 'rgb(180, 35, 24)');
  const previewBox = await filesToInclude.boundingBox();
  assert.ok(previewBox.height <= 240);
  const overview = await fixturePage.evaluate(() => {
    const root = document.querySelector('#mca-side-panel-host').shadowRoot;
    const mode = root.querySelector('[data-grading-mode]');
    return { modeTop: mode.getBoundingClientRect().top, toolsBottom: root.querySelector('.panel-tools').getBoundingClientRect().bottom, fontSize: parseFloat(getComputedStyle(mode).fontSize) };
  });
  assert.ok(overview.modeTop > overview.toolsBottom);
  assert.ok(overview.fontSize >= 14);
  console.log('PASS: file previews remain compact and accessible, and prominent grading status appears below the tool icons.');
  console.log('PASS: supervision detects the task title and describes reference files separately from submissions without downloading them.');
  const referenceResult = await send({ type: 'mca.correctAssignment', requestId: 'reference-separation', assignmentData: detected });
  assert.equal(referenceResult.ok, true, referenceResult.error);
  assert.equal(referenceResult.correction.skippedFiles[0].name, 'reference.zip');
  const evidence = JSON.parse(lastChat.messages[1].content.split('Attached evidence JSON:\n')[1]);
  assert.equal(evidence.attachments.find((file) => file.role === 'assignment-reference').textContent.trim(), 'Fictional teacher reference requirements.');
  assert.equal(evidence.attachments.find((file) => file.role === 'student-submission').textContent.trim(), 'Fictional student authored answer.');
  assert.deepEqual(evidence.attachments.find((file) => file.role === 'assignment-reference').imagePositions, [1]);
  assert.equal(lastChat.messages[1].images.length, 1);
  assert.doesNotMatch(lastChat.messages[1].content, /template worksheet\.odt|fictional\.txt|pluginfile\.php/);
  assert.equal(templateDownloads, 1);
  console.log('PASS: correction reads assignment ODT references and student files locally, preserving separate roles and omitting identifying filenames and URLs.');
  assert.match(await fixturePage.locator('#mca-side-panel-host [data-grading-mode]').textContent(), /Calificación directa simple · sobre 10/);
  const fixtureTabId = await page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, fixturePage.url());
  const popup = await context.newPage();
  await popup.addInitScript(({ id, url }) => { chrome.tabs.query = async () => [{ id, url }]; }, { id: fixtureTabId, url: fixturePage.url() });
  await popup.setViewportSize({ width: 480, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Corrector abierto'));
  assert.deepEqual(await popup.locator('nav button').allTextContents(), ['Añadir sitio', 'Gestionar sitios']);
  assert.equal(await popup.locator('textarea, input[type=file], #requestCorrection, #apiKey').count(), 0);
  assert.equal(await popup.locator('#add-view').isVisible(), false);
  assert.equal(await popup.locator('#manage-view').isVisible(), false);
  assert.equal(await popup.locator('body').evaluate(element => element.getBoundingClientRect().width), 480);
  assert.equal(await popup.locator('html').evaluate(element => getComputedStyle(element).minWidth), '480px');
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await popup.locator('body').screenshot({ path: 'node_modules/review-popup-sites.png' });
  console.log('PASS: the toolbar popup contains only site actions while correction remains in the Moodle sidebar.');
  await popup.locator('#add-site').click();
  assert.equal(await popup.locator('#site-url').inputValue(), `${fixtureOrigin}/school/moodle`);
  assert.equal(await popup.locator('#site-url').evaluate(element => element.getBoundingClientRect().width >= 400), true);
  await popup.locator('body').screenshot({ path: 'node_modules/review-popup-add-site.png' });
  await popup.locator('#save-site').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Sitio añadido'));
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 1);
  await popup.locator('#add-site').click();
  await popup.locator('#site-url').fill('https://second-moodle.test/learning');
  await popup.locator('#save-site').click();
  await popup.waitForFunction(() => document.querySelectorAll('#sites-list li').length === 2);
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 2);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await popup.locator('body').screenshot({ path: 'node_modules/review-popup-manage-sites.png' });
  console.log('PASS: the 480px popup retains readable site input and list widths without horizontal overflow.');
  await popup.getByRole('button', { name: 'Quitar https://second-moodle.test/learning', exact: true }).click();
  await popup.waitForFunction(() => document.querySelectorAll('#sites-list li').length === 1);
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 1);
  console.log('PASS: sites can be added and removed independently with matching persistent script registrations.');
  await popup.close();
  const sitesPopup = await context.newPage();
  await sitesPopup.addInitScript(({ id }) => { chrome.tabs.query = async () => [{ id, url: 'https://example.test/' }]; }, { id: fixtureTabId });
  await sitesPopup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await sitesPopup.waitForFunction(() => document.querySelector('#status').textContent.includes('Añade un Moodle'));
  await sitesPopup.locator('#manage-sites').click();
  await sitesPopup.locator('#sites-list li').waitFor();
  assert.equal(await sitesPopup.locator('#sites-list li').count(), 1);
  await sitesPopup.close();
  console.log('PASS: saved sites remain manageable from the toolbar outside Moodle grading pages.');
  console.log('PASS: direct grading without a max attribute detects the labelled maximum and shows the mode in the sidebar.');
  const extractFixture = () => page.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'mca.extractAssignment' }), fixtureTabId);
  for (const label of ['Cualificación sobre 20', 'Grade out of 20', 'Nota sobre 20,5']) {
    await fixturePage.locator('label[for="id_grade"]').evaluate((element, text) => { element.textContent = text; }, label);
    const response = await extractFixture();
    assert.equal(response.assignmentData.maxScore, label.includes(',') ? 20.5 : 20);
  }
  await fixturePage.locator('label[for="id_grade"]').evaluate((element) => { element.textContent = 'Grade'; });
  assert.equal((await extractFixture()).assignmentData.maxScore, null);
  await fixturePage.locator('input[name="grade"]').evaluate((element) => { element.disabled = true; });
  assert.equal((await extractFixture()).assignmentData.correctionMethod, 'manual');
  await fixturePage.evaluate(() => {
    document.querySelector('#id_grade').disabled = false;
    document.querySelector('label[for="id_grade"]').textContent = 'Calificación sobre 10';
    const guide = document.createElement('div');
    guide.className = 'gradingform_guide';
    guide.innerHTML = '<div class="criterion"><span class="description">Fictional guide criterion</span></div>';
    document.body.appendChild(guide);
  });
  assert.equal((await extractFixture()).assignmentData.correctionMethod, 'grading-guide');
  await fixturePage.locator('.gradingform_guide').evaluate((element) => { element.remove(); });
  await extractFixture();
  console.log('PASS: localized maxima, unknown maxima, disabled grade fields, and grading-guide priority are detected correctly.');
  for (const width of [1280, 960, 600]) {
    await fixturePage.setViewportSize({ width, height: 800 });
    await fixturePage.waitForFunction(() => {
      const panel = document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('.panel').getBoundingClientRect();
      return [...document.querySelectorAll('body, [data-region="grading-navigation-panel"], [data-region="review-panel"], [data-region="grade"], [data-region="grade-actions-panel"]')]
        .every(element => element.getBoundingClientRect().right <= panel.left + 1)
        && document.querySelector('[data-region="review-panel"]').getBoundingClientRect().height >= 600
        && document.querySelector('[data-region="grade"]').getBoundingClientRect().height >= 600
        && document.querySelector('[data-region="grade-actions-panel"]').getBoundingClientRect().bottom <= innerHeight + 1
        && document.querySelector('[data-region="grade-actions-panel"]').getBoundingClientRect().top >= innerHeight - 61;
    });
  }
  await fixturePage.setViewportSize({ width: 1280, height: 800 });
  await fixturePage.screenshot({ path: 'node_modules/review-panel-layout.png' });
  await filesToInclude.scrollIntoViewIfNeeded();
  await fixturePage.screenshot({ path: 'node_modules/review-file-preview.png' });
  await fixturePage.locator('#mca-side-panel-host [data-close]').click();
  await fixturePage.waitForFunction(() => !document.documentElement.classList.contains('mca-panel-open'));
  const restored = await fixturePage.locator('[data-region="grade-actions-panel"]').boundingBox();
  assert.equal(restored.width, 1280);
  assert.equal(await fixturePage.evaluate(() => document.body.style.transform), '');
  await fixturePage.locator('#mca-floating-button-host button').click();
  console.log('PASS: normal, absolute, and fixed Moodle regions fit beside the AI panel at three widths and restore on close.');
  const gradingResponse = { gradingContext: detected.gradingContext, parsed: { studentFeedback: 'Fictional feedback for the first student.', score: 8, rubricSelections: [] } };
  const applyOnFixture = (correction) => page.evaluate(async ({ url, correction }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.applyCorrection', correction });
  }, { url: fixturePage.url(), correction });
  for (const score of [-1, 11, true, 'not-a-grade']) {
    const invalid = await applyOnFixture({ ...gradingResponse, parsed: { ...gradingResponse.parsed, score } });
    assert.equal(invalid.ok, false);
    assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '');
    assert.equal(await fixturePage.locator('textarea[name="assignfeedbackcomments_editor[text]"]').inputValue(), '');
  }
  const validApply = await applyOnFixture(gradingResponse);
  assert.equal(validApply.ok, true, validApply.error);
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '8');
  assert.equal(await fixturePage.frameLocator('#id_assignfeedbackcomments_editor_ifr').locator('body').textContent(), gradingResponse.parsed.studentFeedback);
  await fixturePage.locator('input[name="grade"]').fill('');
  await fixturePage.locator('textarea[name="assignfeedbackcomments_editor[text]"]').fill('');
  console.log('PASS: invalid manual scores leave all fields untouched and valid scores still apply.');
  const panelField = (selector) => fixturePage.locator(`#mca-side-panel-host ${selector}`);
  assert.equal(await panelField('[data-external-correction]').isVisible(), false);
  assert.equal(await panelField('[data-provider]').isVisible(), false);
  assert.equal(await panelField('[data-diagnostics]').isVisible(), false);
  await panelField('[data-tool="json"]').click();
  for (const invalid of ['{broken', '{"studentFeedback":"Must not write","score":99}', '{"studentFeedback":"Must not write","score":1,"needsRepair":true}']) {
    await panelField('[data-external-correction]').fill(invalid);
    await panelField('[data-apply-correction]').click();
    await fixturePage.waitForFunction(() => /inválid|válida/.test(document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent));
    assert.equal(await panelField('[data-apply-correction]').isEnabled(), true);
    assert.equal(await fixturePage.locator('#id_grade').inputValue(), '');
    assert.equal(await fixturePage.locator('#id_assignfeedbackcomments_editor').inputValue(), '');
  }
  await fixturePage.keyboard.press('Escape');
  console.log('PASS: panel JSON parse, score, and repair errors appear in its status without altering Moodle fields.');
  for (const name of ['Configuración de IA', 'JSON de corrección', 'Datos y diagnóstico']) {
    const tool = fixturePage.getByRole('button', { name, exact: true });
    await tool.click();
    assert.equal(await tool.getAttribute('aria-expanded'), 'true');
    if (name === 'Configuración de IA') {
      assert.equal(await panelField('[data-provider]').isVisible(), true);
      ollamaModels = [{ name: 'fictional-vision' }, { name: 'other-8b', details: { parameter_size: '8B', quantization_level: 'Q4' } }, { name: 'third-model' }];
      await panelField('[data-runtime-refresh]').click();
      await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-model]').options.length === 4);
      await panelField('[data-model-search]').fill('8B');
      assert.equal(await panelField('[data-model] option').count(), 3);
      assert.equal(await panelField('[data-model]').inputValue(), 'fictional-vision');
      assert.match(await panelField('[data-model]').textContent(), /other-8b.*Q4/);
      await fixturePage.screenshot({ path: 'node_modules/review-panel-settings.png' });
      await panelField('[data-model-search]').fill('');
      ollamaModels = [{ name: 'fictional-vision' }];
      await panelField('[data-runtime-refresh]').click();
      await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-model]').options.length === 2);
      console.log('PASS: grading-panel model search filters names/metadata and retains the configured model.');
      assert.equal(await panelField('[data-provider] option').count(), 7);
      await panelField('[data-runtime-options]').click();
      await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent.includes('Conexión verificada'));
      await panelField('[data-ai-mode="advanced"]').click();
      const advanced = fixturePage.frameLocator('iframe[title="Configuración avanzada de IA"]');
      await advanced.locator('#endpointHost').waitFor({ state: 'visible' });
      const advancedFrame = fixturePage.frames().find(frame => frame.url().includes('embedded=1'));
      await advancedFrame.waitForFunction(endpoint => document.querySelector('#baseUrl').value === endpoint, baseUrl);
      assert.equal(await advanced.locator('#provider').inputValue(), 'ollama');
      assert.equal(await advanced.locator('#baseUrl').inputValue(), baseUrl);
      assert.equal(await fixturePage.evaluate(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('iframe').contentDocument), null);
      await advanced.locator('#endpointPort').fill('65536');
      assert.equal(await advanced.locator('#endpointPort').evaluate(element => element.checkValidity()), false);
      await advanced.locator('#baseUrl').fill(baseUrl);
      await advanced.locator('#load-models').click();
      await advanced.locator('#available-models option').first().waitFor();
      await advanced.locator('#test-connection').click();
      await advanced.locator('#status').filter({ hasText: 'Conexión verificada' }).waitFor();
      await advanced.locator('#provider').selectOption('lm-studio');
      await advanced.locator('#baseUrl').fill(`${baseUrl}/v1`);
      await advanced.locator('#model').fill('fictional-vision');
      await advanced.locator('#apiKey').fill('fictional-panel-key');
      await advanced.locator('#test-connection').click();
      await advanced.locator('#status').filter({ hasText: 'Conexión verificada: lm-studio' }).waitFor();
      assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.hasApiKey, true);
      await advanced.locator('#remove-api-key').click();
      await advanced.locator('#status').filter({ hasText: 'Clave de API guardada eliminada' }).waitFor();
      assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.hasApiKey, false);
      await advanced.locator('#provider').selectOption('ollama');
      await advanced.locator('#model').fill('fictional-vision');
      await advanced.locator('button[type="submit"]').click();
      await advanced.locator('#status').filter({ hasText: 'Configuración guardada' }).waitFor();
      await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-provider]').value === 'ollama');
      console.log('PASS: advanced panel settings save provider profiles, test generation, and add/delete a session key without leaving Moodle.');
      await fixturePage.evaluate(() => { document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('.content').scrollTop = 0; });
      await advancedFrame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // Let the embedded renderer update its viewport after outer scrolling.
      await fixturePage.waitForTimeout(100);
      await fixturePage.screenshot({ path: 'node_modules/review-panel-advanced.png' });
      await fixturePage.setViewportSize({ width: 600, height: 800 });
      assert.equal(await advanced.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await fixturePage.screenshot({ path: 'node_modules/review-panel-advanced-600.png' });
      await fixturePage.setViewportSize({ width: 1280, height: 800 });
      await panelField('[data-ai-mode="simple"]').click();
      await fixturePage.waitForFunction(() => !document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-ai-simple]').hidden);
      assert.equal(await panelField('[data-ai-simple]').isVisible(), true);
      assert.equal(await panelField('[data-ai-advanced]').isVisible(), false);
      for (const id of ['lm-studio', 'ollama']) {
        await panelField('[data-provider]').selectOption(id);
        await fixturePage.waitForFunction(providerId => {
          const root = document.querySelector('#mca-side-panel-host').shadowRoot;
          return root.querySelector('[data-provider]').value === providerId && root.querySelector('[data-model]').value === 'fictional-vision';
        }, id);
        assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.provider, id);
      }
      console.log('PASS: simple and advanced panel modes share full options behavior and isolate API fields from the Moodle document.');
    }
    await fixturePage.keyboard.press('Escape');
    assert.equal(await tool.getAttribute('aria-expanded'), 'false');
    assert.equal(await tool.evaluate(element => element.getRootNode().activeElement === element), true);
  }
  console.log('PASS: technical controls are hidden by default and accessible through labelled icons with Escape and focus restoration.');
  await fixturePage.setViewportSize({ width: 600, height: 800 });
  assert.equal(await panelField('[data-tool="settings"]').isVisible(), true);
  await fixturePage.screenshot({ path: 'node_modules/review-panel-compact.png' });
  await fixturePage.setViewportSize({ width: 1280, height: 800 });
  await panelField('[data-tool="json"]').click();
  await panelField('[data-external-correction]').fill('{"score":8,"finalComment":"Previous student"}');
  await panelField('[data-correction]').fill('Previous AI suggestion');
  await fixturePage.getByRole('button', { name: 'Volver a la corrección', exact: true }).click();
  await panelField('[data-assignment-instructions]').fill('Previous instructions');
  await panelField('[data-course-instructions]').fill('Course-wide criterion');
  await panelField('[data-extra-instructions]').fill('Only student one');
  await panelField('.instruction-fields').scrollIntoViewIfNeeded();
  await fixturePage.screenshot({ path: 'node_modules/review-teacher-criteria.png' });
  await panelField('[data-assignment-instructions]').fill('Persistent instructions');
  await page.waitForFunction(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('Persistent instructions'));
  await panelField('[data-close]').click();
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Persistent instructions');
  console.log('PASS: instructions persist locally when closing and reopening the correction sidebar.');
  await panelField('[data-extra-files]').setInputFiles({ name: 'previous.txt', mimeType: 'text/plain', buffer: Buffer.from('Fictional attachment') });
  assert.match(await filesToInclude.locator('[data-file-role="teacher-additional"]').textContent(), /previous\.txt/);
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('userid=1', 'userid=2')));
  await fixturePage.waitForFunction(() => {
    const root = document.querySelector('#mca-side-panel-host').shadowRoot;
    return ['[data-external-correction]', '[data-correction]', '[data-extra-files]'].every(selector => root.querySelector(selector).value === '')
      && root.querySelector('[data-status]').textContent === 'Datos detectados listos.';
  });
  assert.equal(await panelField('[data-extra-files]').evaluate(element => element.files.length), 0);
  assert.equal(await filesToInclude.locator('[data-file-role="teacher-additional"]').count(), 0);
  assert.equal(await panelField('[data-assignment-instructions]').inputValue(), 'Persistent instructions');
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === '');
  assert.equal(await panelField('[data-course-instructions]').inputValue(), 'Course-wide criterion');
  await panelField('[data-extra-instructions]').fill('Only student two');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('userid=2', 'userid=1')));
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === 'Only student one');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('userid=1', 'userid=2')));
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === 'Only student two');
  console.log('PASS: changing students preserves course/task criteria and restores only the matching student case.');
  await fixturePage.evaluate(() => { const url = new URL(location.href); url.searchParams.set('attemptnumber', '1'); history.replaceState({}, '', url); });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === '');
  await panelField('[data-extra-instructions]').fill('Only the second attempt');
  await fixturePage.evaluate(() => { const url = new URL(location.href); url.searchParams.delete('attemptnumber'); history.replaceState({}, '', url); });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === 'Only student two');
  console.log('PASS: case criteria remain separate for different attempts by the same student.');
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-grading-mode]').textContent.includes('sobre 10'));
  assert.match(await panelField('[data-grading-mode]').textContent(), /sobre 10/);
  assert.equal(await panelField('.panel').getAttribute('data-open'), 'true');
  console.log('PASS: student navigation clears corrections and attachments, preserves instructions, and detects the new page with the panel open.');
  const staleApply = await page.evaluate(async ({ url, correction }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.applyCorrection', correction });
  }, { url: `${fixtureOrigin}${fixturePath}&action=grader&userid=2`, correction: gradingResponse });
  assert.equal(staleApply.ok, false, 'A correction must not be applied after switching students.');
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '');
  assert.equal(await fixturePage.locator('textarea[name="assignfeedbackcomments_editor[text]"]').inputValue(), '');
  console.log('PASS: switching students blocks stale corrections before any form field changes.');
  await fixturePage.evaluate(() => {
    history.replaceState({}, '', location.href.replace('userid=2', 'userid=1'));
    document.querySelector('.assignsubmission_file').remove();
  });
  const returnedApply = await applyOnFixture(gradingResponse);
  assert.equal(returnedApply.ok, false, 'Returning to the old URL must not revive the old correction.');
  await fixturePage.waitForFunction(() => {
    const root = document.querySelector('#mca-side-panel-host').shadowRoot;
    return root.querySelector('[data-status]').textContent === 'Datos detectados listos.' && root.querySelector('[data-extra-instructions]').value === 'Only student one';
  });
  const fresh = await page.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.extractAssignment' });
  }, fixturePage.url());
  chatDelayMs = 250;
  const observedChat = new Promise((resolve) => { onChat = resolve; });
  const pendingCorrection = page.evaluate(async ({ url, assignmentData }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, { type: 'mca.requestCorrection', assignmentData });
  }, { url: fixturePage.url(), assignmentData: fresh.assignmentData });
  await Promise.race([observedChat, pendingCorrection.then(result => { throw new Error(`Correction ended before reaching the mock provider: ${JSON.stringify(result)}`); })]);
  onChat = null;
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('userid=1', 'userid=2')));
  const changedStudent = await pendingCorrection;
  chatDelayMs = 0;
  assert.equal(changedStudent.ok, false);
  assert.match(changedStudent.error, /han cambiado/);
  assert.doesNotMatch(lastChat.messages[1].content, /gradingContext|userid=/);
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '');
  console.log('PASS: delayed AI replies are rejected after navigation and local context is not sent to AI.');
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent === 'Datos detectados listos.');
  chatDelayMs = 350;
  const uiChat = new Promise(resolve => { onChat = resolve; });
  await panelField('[data-correct]').click();
  await uiChat;
  onChat = null;
  await fixturePage.evaluate(() => history.pushState({}, '', location.href.replace('userid=2', 'userid=3')));
  await fixturePage.waitForFunction(() => {
    const root = document.querySelector('#mca-side-panel-host').shadowRoot;
    return root.querySelector('[data-status]').textContent === 'Datos detectados listos.' && !root.querySelector('[data-correct]').disabled;
  });
  assert.equal(await panelField('[data-correction]').inputValue(), '');
  assert.equal(await panelField('[data-cancel-correction]').isVisible(), false);
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '');
  chatDelayMs = 0;
  await panelField('[data-correct]').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent.includes('Corrección aplicada'));
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '8');
  assert.match(await panelField('[data-result]').textContent(), /Nota propuesta: 8.*Fictional work reviewed/s);
  const criteriaPayload = JSON.parse(lastChat.messages[1].content.split('Assignment data:\n')[1].split('\n\nAttached evidence JSON:')[0]);
  assert.deepEqual(criteriaPayload.teacherCriteria, { course: 'Course-wide criterion', assignment: 'Persistent instructions', case: '' });
  assert.ok(lastChat.messages[0].content.includes('Course-wide criterion'));
  assert.ok(lastChat.messages[0].content.includes('Persistent instructions'));
  assert.match(lastChat.messages[0].content, /Teacher-declared assessment assumptions and waivers are authoritative/);
  console.log('PASS: sidebar teacher criteria reach the provider as explicit system guidance with declared-assumption handling.');

  assert.equal(await panelField('[data-correction]').isVisible(), false);
  console.log('PASS: a generated correction is shown as readable feedback and a proposed grade while its JSON stays behind the tool icon.');
  console.log('PASS: navigation during a panel request cancels the old work, restores controls, and allows a fresh correction without stale UI updates.');
  await panelField('[data-extra-instructions]').fill('Only student three');
  await fixturePage.evaluate(() => {
    const input = document.createElement('input'); input.name = 'userid'; input.type = 'hidden'; input.value = '4'; document.body.appendChild(input);
  });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-correction]').value === '');
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-extra-instructions]').value === '');
  assert.equal(await fixturePage.locator('input[name="grade"]').inputValue(), '8', 'Reset must not erase Moodle form fields.');
  console.log('PASS: a changed student identity without URL navigation resets the assistant while preserving Moodle form fields.');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('id=42&', 'id=43&')));
  await fixturePage.waitForFunction(() => {
    const root = document.querySelector('#mca-side-panel-host').shadowRoot;
    return root.querySelector('[data-assignment-instructions]').value === 'Persistent instructions' && root.querySelector('[data-course-instructions]').value === 'Course-wide criterion';
  });
  await panelField('[data-assignment-instructions]').fill('Only task forty-three');
  await fixturePage.evaluate(() => {
    history.replaceState({}, '', location.href.replace('id=43&', 'id=44&'));
    document.body.className = 'course-8';
  });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Only task forty-three');
  assert.equal(await panelField('[data-course-instructions]').inputValue(), 'Course-wide criterion');
  assert.equal(await panelField('[data-extra-instructions]').inputValue(), '');
  await fixturePage.evaluate(() => {
    document.body.className = 'course-7';
    history.replaceState({}, '', location.href.replace('id=44&', 'id=42&'));
  });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Persistent instructions');
  console.log('PASS: new courses and tasks copy defaults without copying case criteria or overwriting saved task criteria.');
  await panelField('[data-tool="json"]').click();
  await panelField('[data-external-correction]').fill('Previous page JSON');
  await fixturePage.reload();
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  assert.equal(await panelField('[data-external-correction]').inputValue(), '');
  assert.equal(await panelField('[data-correction]').inputValue(), '');
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Persistent instructions');
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-grading-mode]').textContent.includes('sobre 10'));
  console.log('PASS: full page navigation creates a clean assistant that detects the new page when opened.');
  await panelField('[data-assignment-instructions]').fill('');
  await page.waitForFunction(async () => Object.entries(await chrome.storage.local.get(null)).some(([key, value]) => key.endsWith(':assignment:42') && value === ''));
  await fixturePage.reload();
  await fixturePage.locator('#mca-side-panel-host').waitFor({ state: 'attached' });
  assert.equal(await panelField('[data-assignment-instructions]').inputValue(), '');
  console.log('PASS: clearing instructions persists an empty value instead of restoring previous instructions.');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('id=42&', 'id=43&')));
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Only task forty-three');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('id=43&', 'id=42&')));
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === '');
  console.log('PASS: a deliberately cleared task criterion stays empty even when a nonempty copying default exists.');
  await fixturePage.evaluate(() => history.replaceState({}, '', location.href.replace('id=42&', 'id=43&')));
  await page.waitForFunction(async () => Object.entries(await chrome.storage.local.get(null)).some(([key, value]) => key.endsWith(':default:assignment') && value === 'Only task forty-three'));
  await fixturePage.goto(`${fixtureOrigin}${fixturePath.replace('id=42', 'id=46')}&action=grader&userid=3`);
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-assignment-instructions]').value === 'Only task forty-three');
  assert.equal(await panelField('[data-course-instructions]').inputValue(), 'Course-wide criterion');
  assert.equal(await panelField('[data-extra-instructions]').inputValue(), '');
  await fixturePage.goto(`${fixtureOrigin}${fixturePath}&action=grader&userid=3`);
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  await fixturePage.locator('#mca-floating-button-host button').click();
  console.log('PASS: a new document copies saved course/task defaults while leaving the concrete case empty.');
  const otherOrigin = 'https://other-moodle-corrector.test';
  await context.route(`${otherOrigin}/**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><body class="course-7"><div data-region="grade"><input id="id_grade" name="grade" max="10"><textarea name="assignfeedbackcomments_editor[text]"></textarea></div></body></html>' }));
  await fixturePage.goto(`${otherOrigin}${fixturePath}&action=grader&userid=3`);
  assert.equal(await fixturePage.locator('#mca-side-panel-host').count(), 0);
  await activatePage(fixturePage.url());
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  await fixturePage.locator('#mca-floating-button-host button').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent === 'Datos detectados listos.');
  for (const selector of ['[data-course-instructions]', '[data-assignment-instructions]', '[data-extra-instructions]']) assert.equal(await panelField(selector).inputValue(), '');
  await fixturePage.goto(`${fixtureOrigin}${fixturePath}&action=grader&userid=3`);
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  await fixturePage.locator('#mca-floating-button-host button').click();
  console.log('PASS: automatic criteria defaults stay inside their Moodle installation and do not cross into another site.');
  await page.evaluate(() => chrome.storage.local.set({ correctorExtraInstructions: 'Previous saved instructions' }));
  await fixturePage.reload();
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  await fixturePage.locator('#mca-floating-button-host button').click();
  await panelField('[data-recover-instructions]').waitFor({ state: 'visible' });
  assert.equal(await panelField('[data-assignment-instructions]').inputValue(), '');
  await panelField('[data-recover-instructions]').click();
  assert.equal(await panelField('[data-assignment-instructions]').inputValue(), 'Previous saved instructions');
  assert.equal(await panelField('[data-course-instructions]').inputValue(), 'Course-wide criterion');
  assert.equal(await panelField('[data-extra-instructions]').inputValue(), 'Only student three');
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('correctorExtraInstructions')).correctorExtraInstructions), 'Previous saved instructions');
  console.log('PASS: legacy instructions are retained and copied into the current task only on explicit recovery.');
  const mediaOdt = zipSync({
    'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>OMITTED_ODT_SECRET</text:p></office:text></office:body></office:document-content>'),
    'Pictures/unsupported.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await panelField('[data-extra-files]').setInputFiles([
    { name: 'unsupported-media.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: Buffer.from(mediaOdt) },
    { name: 'valid-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('INCLUDED_TEXT_EVIDENCE') },
    { name: 'ignored.zip', mimeType: 'application/zip', buffer: Buffer.from('OMITTED_ZIP_SECRET') },
  ]);
  const additionalSkipped = filesToInclude.locator('[data-file-role="teacher-additional"][data-file-status="skipped"]');
  assert.equal(await additionalSkipped.count(), 1);
  assert.match(await additionalSkipped.textContent(), /ignored\.zip.*Omitido/s);
  console.log('PASS: unsupported manual files are marked red and omitted before reading their bytes.');
  await panelField('[data-correct]').click();
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').shadowRoot.querySelector('[data-status]').textContent.includes('Corrección aplicada'));
  assert.equal(await additionalSkipped.count(), 2);
  assert.match(await additionalSkipped.allTextContents().then(items => items.join('\n')), /unsupported-media\.odt.*Contenido de formato no soportado/s);
  assert.match(lastChat.messages[1].content, /INCLUDED_TEXT_EVIDENCE/);
  assert.doesNotMatch(lastChat.messages[1].content, /OMITTED_ODT_SECRET|OMITTED_ZIP_SECRET|unsupported-media\.odt|ignored\.zip/);
  await filesToInclude.scrollIntoViewIfNeeded();
  await fixturePage.screenshot({ path: 'node_modules/review-unsupported-files.png' });
  await panelField('[data-extra-files]').setInputFiles({ name: 'unsupported-media.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: Buffer.from(referenceOdt) });
  assert.equal(await additionalSkipped.count(), 0, 'Replacing a file must discard its old runtime omission status.');
  console.log('PASS: unsupported embedded formats are reported back in red while supported evidence continues to AI.');
  await fixturePage.evaluate(() => {
    const rubric = document.createElement('div');
    rubric.className = 'gradingform_rubric';
    rubric.id = 'audit-rubric';
    rubric.innerHTML = [1, 2].map((id) => `<div class="criterion" id="audit-criterion-${id}"><div class="description">Criterion ${id}</div><div class="levels"><label class="level" for="audit-level-${id}-0">Low<input type="radio" id="audit-level-${id}-0" name="criteria[${id}][levelid]" value="${id}0"></label><label class="level" for="audit-level-${id}-1">High<input type="radio" id="audit-level-${id}-1" name="criteria[${id}][levelid]" value="${id}1"></label></div><textarea name="remark-${id}"></textarea></div>`).join('');
    document.body.append(rubric);
    document.querySelector('#id_grade').value = '';
    document.querySelector('#id_assignfeedbackcomments_editor').value = '';
  });
  const rubricContext = (await extractFixture()).assignmentData.gradingContext;
  const rubricCorrection = { studentFeedback: 'Audited rubric', score: 7, rubricSelections: [
    { levelIndex: 1, criterionFeedback: 'First evidence' }, { levelIndex: 0, criterionFeedback: 'Second evidence' },
  ] };
  assert.equal((await applyOnFixture({ gradingContext: rubricContext, parsed: rubricCorrection })).ok, false);
  assert.equal(await fixturePage.locator('#id_grade').inputValue(), '');
  assert.equal(await fixturePage.locator('#audit-rubric input:checked').count(), 0);
  rubricCorrection.rubricSelections[0].criterionId = 'audit-criterion-2';
  rubricCorrection.rubricSelections[1].criterionId = 'audit-criterion-1';
  const mappedRubric = await applyOnFixture({ gradingContext: rubricContext, parsed: rubricCorrection });
  assert.equal(mappedRubric.ok, true, mappedRubric.error);
  assert.equal(await fixturePage.locator('#audit-level-2-1').isChecked(), true);
  assert.equal(await fixturePage.locator('#audit-level-1-0').isChecked(), true);
  await fixturePage.locator('#audit-rubric').evaluate((element) => element.remove());
  console.log('PASS: rubric selections require explicit identities and apply correctly even in reverse criterion order.');
  await fixturePage.evaluate(() => { history.replaceState({}, '', '/school/moodle/course/view.php?id=7'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').dataset.navigationWatch === 'stopped');
  assert.equal(await fixturePage.evaluate(() => document.documentElement.classList.contains('mca-panel-open')), false);
  await fixturePage.evaluate(() => { history.replaceState({}, '', '/school/moodle/mod/assign/view.php?id=42&action=grader&userid=99'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await fixturePage.waitForFunction(() => document.querySelector('#mca-side-panel-host').dataset.navigationWatch === 'active');
  console.log('PASS: leaving the grader stops navigation timers/observation and returning restarts the watcher.');
  await send({ type: 'mca.setAiRuntimeConfig', config: { apiKey: 'fictional-session-key' } });
  await page.reload();
  await page.locator('#remove-api-key').waitFor({ state: 'visible' });
  await page.locator('#remove-api-key').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Clave de API guardada eliminada.');
  assert.equal((await send({ type: 'mca.getAiRuntimeStatus' })).status.appConfig.hasApiKey, false);
  assert.equal(await page.evaluate(async () => (await chrome.storage.session.get('mca.aiSecret'))['mca.aiSecret'].apiKey), undefined);
  console.log('PASS: the settings button deletes the session API key and confirms its removal.');
  const activationPopup = await context.newPage();
  await activationPopup.addInitScript(({ id, url }) => { chrome.tabs.query = async () => [{ id, url }]; }, { id: fixtureTabId, url: fixturePage.url() });
  await activationPopup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await activationPopup.waitForFunction(() => document.querySelector('#status').textContent.includes('Corrector abierto'));
  await activationPopup.locator('#manage-sites').click();
  await activationPopup.locator('#sites-list button').click();
  await activationPopup.locator('#empty-sites').waitFor({ state: 'visible' });
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  await activationPopup.close();
  await fixturePage.reload();
  assert.equal(await fixturePage.locator('#mca-side-panel-host').count(), 0);
  await activatePage(fixturePage.url());
  await fixturePage.locator('#mca-floating-button-host').waitFor({ state: 'attached' });
  console.log('PASS: disabling automatic activation unregisters the site, leaves the next page inactive, and preserves manual activation.');
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
  const content = (withText ? 'BT /F1 16 Tf 30 100 Td (Fictional PDF evidence) Tj ET' : '') +
    (!withText || withText === 'mixed' ? ' 0 0 1 rg 30 30 60 60 re f' : '') +
    (withText === 'raster' ? ' q 120 0 0 60 30 30 cm /Im1 Do Q' : '');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> ${withText === 'raster' ? '/XObject << /Im1 6 0 R >>' : ''} >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (withText === 'raster') objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
