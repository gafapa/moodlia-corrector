// End-to-end check of the built extension on a real, disposable Moodle site.
//
// tests/browser-check.mjs proves the panel against a synthetic grader page;
// this check opens Moodle's own grader (mod/assign/view.php?action=grader) on a
// lab site prepared by tests/moodle-lab/setup.php, signs in as the fixture
// teacher, remembers the site in the extension, runs a correction against a
// local fake Ollama server, saves the grade with Moodle's "Save changes" and
// reloads it, and checks the gradebook-overridden student. It then corrects the
// fixture's marking guide and scale assignments the same way, and with a fixture
// that makes TinyMCE the teacher's editor it checks that the feedback lands in
// TinyMCE and survives the save. No real AI is used.
//
// The extension only runs on HTTPS grader pages and only downloads submission
// files over HTTPS, so the lab site must be served over HTTPS. Lab images speak
// HTTP; with MOODLE_UPSTREAM set, this script terminates TLS itself with a
// self-signed certificate and Chromium ignores certificate errors.
//
// Run `node tests/moodle-lab-check.mjs --help` for the configuration.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const usage = `Usage: node tests/moodle-lab-check.mjs [--self-test] [--help]

Environment:
  MOODLE_URL           Public HTTPS URL of the lab site, equal to its wwwroot
                       (for example https://127.0.0.1:18443). Required.
  MOODLE_UPSTREAM      Optional HTTP URL of the lab container (for example
                       http://127.0.0.1:18080). When set, this script serves
                       MOODLE_URL as a TLS proxy to it. The container must run
                       with SITE_URL=MOODLE_URL, SSLPROXY=true and
                       REVERSEPROXY=true; MOODLE_URL must not use port 443.
  MOODLE_TLS_CERT      PEM certificate and key for the proxy. When unset, a
  MOODLE_TLS_KEY       temporary self-signed pair is created with openssl.
  MOODLE_LAB_FIXTURE   Path to the JSON printed by tests/moodle-lab/setup.php
                       (its last line). Required unless MOODLE_LAB_FIXTURE_JSON
                       holds the JSON itself.
  MOODLE_USERNAME      Override the fixture teacher's username and password.
  MOODLE_PASSWORD
  MOODLE_LAB_ARTIFACTS Directory for screenshots and logs written on failure
                       (default node_modules/.cache/moodle-lab).
  MOODLE_LAB_TIMEOUT_MS  Timeout of each page wait (default 30000).
  MOODLE_LAB_AI_TIMEOUT_MS  Timeout of each AI correction (default 180000).
  MOODLE_LAB_READY_TIMEOUT_MS  Time to wait for the site (default 180000).
  MOODLE_LAB_HEADED=1  Show the browser window.

--self-test starts the fake AI server and the TLS proxy against a local stub,
checks both, and exits without Moodle or a browser.`;

const extensionPath = path.resolve('extension');
const AI_MODEL = 'fictional-vision';
const STATUS_READY = 'Detected data ready.';
const STATUS_APPLIED = 'Applied to Moodle. Review the grade and feedback before saving.';
const STATUS_GRADE_NOT_APPLIED = 'Feedback applied, but not the grade';

const positiveInteger = (name, value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer of milliseconds, not "${value}".`);
  return number;
};

export const readConfig = async (env = process.env) => {
  const errors = [];
  let moodleUrl;
  try {
    moodleUrl = new URL(String(env.MOODLE_URL || ''));
    if (moodleUrl.protocol !== 'https:') errors.push('MOODLE_URL must use https: the extension only runs on HTTPS grader pages.');
    if (moodleUrl.pathname !== '/' || moodleUrl.search || moodleUrl.hash) errors.push('MOODLE_URL must be the site root without a path, query or fragment.');
  } catch { errors.push('MOODLE_URL is required (for example https://127.0.0.1:18443).'); }
  let upstream = null;
  if (env.MOODLE_UPSTREAM) {
    try {
      upstream = new URL(env.MOODLE_UPSTREAM);
      if (upstream.protocol !== 'http:') errors.push('MOODLE_UPSTREAM must use http:.');
    } catch { errors.push(`MOODLE_UPSTREAM is not a URL: "${env.MOODLE_UPSTREAM}".`); }
    if (moodleUrl && ['', '443'].includes(moodleUrl.port)) {
      errors.push('With MOODLE_UPSTREAM, MOODLE_URL needs a port other than 443: Moodle with REVERSEPROXY and SSLPROXY rejects a request whose host and port equal wwwroot.');
    }
  }
  if (Boolean(env.MOODLE_TLS_CERT) !== Boolean(env.MOODLE_TLS_KEY)) errors.push('Set both MOODLE_TLS_CERT and MOODLE_TLS_KEY, or neither.');
  let fixture;
  try {
    const text = env.MOODLE_LAB_FIXTURE_JSON || (env.MOODLE_LAB_FIXTURE ? await fs.readFile(env.MOODLE_LAB_FIXTURE, 'utf8') : '');
    if (!text.trim()) throw new Error('MOODLE_LAB_FIXTURE (a file) or MOODLE_LAB_FIXTURE_JSON is required.');
    // setup.php prints its JSON on the last line; accept the whole output too.
    fixture = JSON.parse(text.trim().split(/\r?\n/).at(-1));
    for (const key of ['cmid', 'student', 'locked_student', 'submission_file', 'markers', 'guide', 'scale']) {
      if (fixture[key] === undefined) throw new Error(`The fixture JSON has no "${key}"; create it again with the current tests/moodle-lab/setup.php.`);
    }
    if (!fixture.guide.cmid || !Array.isArray(fixture.guide.criteria) || !fixture.guide.criteria.length ||
        fixture.guide.criteria.some((criterion) => !criterion.id || !criterion.dom_id || !(criterion.max_score > 0))) {
      throw new Error('The fixture "guide" needs a cmid and criteria with id, dom_id and a positive max_score.');
    }
    if (!fixture.scale.cmid || !Array.isArray(fixture.scale.items) || fixture.scale.items.length < 2) {
      throw new Error('The fixture "scale" needs a cmid and at least two items.');
    }
  } catch (error) { errors.push(error instanceof SyntaxError ? `The fixture is not JSON: ${error.message}` : error.message); }
  const username = env.MOODLE_USERNAME || fixture?.teacher?.username;
  const password = env.MOODLE_PASSWORD || fixture?.teacher?.password;
  if (fixture && (!username || !password)) errors.push('No teacher credentials: the fixture has none and MOODLE_USERNAME/MOODLE_PASSWORD are unset.');
  let timeoutMs, aiTimeoutMs, readyTimeoutMs;
  try {
    timeoutMs = positiveInteger('MOODLE_LAB_TIMEOUT_MS', env.MOODLE_LAB_TIMEOUT_MS, 30_000);
    aiTimeoutMs = positiveInteger('MOODLE_LAB_AI_TIMEOUT_MS', env.MOODLE_LAB_AI_TIMEOUT_MS, 180_000);
    readyTimeoutMs = positiveInteger('MOODLE_LAB_READY_TIMEOUT_MS', env.MOODLE_LAB_READY_TIMEOUT_MS, 180_000);
  } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}\n\n${usage}`);
  return {
    moodleUrl: moodleUrl.origin, upstream, fixture, username, password,
    tlsCert: env.MOODLE_TLS_CERT || null, tlsKey: env.MOODLE_TLS_KEY || null,
    artifacts: path.resolve(env.MOODLE_LAB_ARTIFACTS || 'node_modules/.cache/moodle-lab'),
    timeoutMs, aiTimeoutMs, readyTimeoutMs,
    headed: env.MOODLE_LAB_HEADED === '1',
  };
};

// A fake Ollama server: model list, capabilities and a fixed correction. Like
// real Ollama it rejects browser origins, which the extension must strip.
// state.content, when set, is returned verbatim as the correction (guide scores,
// a scale grade); otherwise the reply is built from state.feedback and state.score.
export const startFakeAi = async () => {
  const state = { chats: [], feedback: 'Fictional lab review.', score: 8, content: null };
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.origin) { response.statusCode = 403; response.end('{}'); return; }
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: AI_MODEL }] })); return; }
    if (request.url === '/api/show') { response.end(JSON.stringify({ capabilities: ['completion', 'vision'] })); return; }
    if (request.url === '/api/chat' && request.method === 'POST') {
      let chat;
      try { chat = JSON.parse(body); } catch { response.statusCode = 400; response.end('{}'); return; }
      const connectionTest = String(chat.messages?.[0]?.content || '').includes('Connection test');
      if (!connectionTest) state.chats.push(body);
      const content = connectionTest ? '{"status":"ok"}'
        : state.content ?? JSON.stringify({ finalComment: state.feedback, score: state.score, rubricSelections: [] });
      response.end(JSON.stringify({ model: AI_MODEL, done: true, message: { role: 'assistant', content } }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, state, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const createSelfSignedCertificate = async (host) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mca-lab-tls-'));
  const certPath = path.join(directory, 'cert.pem');
  const keyPath = path.join(directory, 'key.pem');
  const altName = /^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', `/CN=${host}`, '-addext', `subjectAltName=${altName}`], { stdio: 'pipe', timeout: 30_000 });
  } catch (error) {
    throw new Error(`Could not create a self-signed certificate with openssl (${error.message.split('\n')[0]}). Install openssl or set MOODLE_TLS_CERT and MOODLE_TLS_KEY.`);
  }
  return { cert: await fs.readFile(certPath), key: await fs.readFile(keyPath), directory };
};

// Terminates TLS for the lab site and forwards to the container over HTTP,
// keeping the public Host so Moodle builds every URL from its wwwroot.
export const startTlsProxy = async ({ listen, upstream, cert, key }) => {
  const server = https.createServer({ cert, key }, (request, response) => {
    const headers = { ...request.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': request.headers.host || listen.host,
      'x-forwarded-for': request.socket.remoteAddress || '127.0.0.1' };
    const forward = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers }, (reply) => {
      response.writeHead(reply.statusCode, reply.statusMessage, reply.rawHeaders);
      reply.pipe(response);
    });
    forward.setTimeout(120_000, () => forward.destroy(new Error('Upstream timeout')));
    forward.on('error', (error) => {
      if (!response.headersSent) { response.writeHead(502, { 'Content-Type': 'text/plain' }); response.end(`Lab proxy: ${error.message}`); }
      else response.destroy(error);
    });
    request.pipe(forward);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(listen.port), listen.hostname.replace(/^\[|\]$/g, ''), resolve); });
  return server;
};

const insecureGet = (url, timeoutMs) => new Promise((resolve, reject) => {
  const request = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { if (body.length < 200_000) body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  });
  request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
  request.on('error', reject);
});

const waitForMoodle = async (moodleUrl, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await insecureGet(`${moodleUrl}/login/index.php`, 15_000);
      if (response.status === 200 && /name="username"|id="username"/.test(response.body)) return;
      last = `HTTP ${response.status}${response.headers.location ? ` to ${response.headers.location}` : ''}${/reverseproxyabused|sslonlyaccess|wwwrootmismatch/i.test(response.body) ? ' (Moodle rejects the proxy setup)' : ''}`;
    } catch (error) { last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Moodle did not serve its login page at ${moodleUrl}/login/index.php within ${timeoutMs} ms (last: ${last}).`);
};

const selfTest = async () => {
  const ai = await startFakeAi();
  const stub = http.createServer((request, response) => {
    response.setHeader('Set-Cookie', ['A=1; Path=/', 'B=2; Path=/']);
    response.end(JSON.stringify({ host: request.headers.host, proto: request.headers['x-forwarded-proto'], url: request.url }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const certificate = await createSelfSignedCertificate('127.0.0.1');
  const probe = https.createServer({ cert: certificate.cert, key: certificate.key });
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const proxy = await startTlsProxy({ listen: new URL(`https://127.0.0.1:${port}`), upstream: new URL(`http://127.0.0.1:${stub.address().port}`), ...certificate });
  try {
    const tags = await (await fetch(`${ai.baseUrl}/api/tags`)).json();
    assert.equal(tags.models[0].name, AI_MODEL);
    const chat = await (await fetch(`${ai.baseUrl}/api/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ content: 'system' }, { content: 'MARKER' }] }) })).json();
    assert.equal(JSON.parse(chat.message.content).score, 8);
    assert.equal(ai.state.chats.length, 1);
    ai.state.content = JSON.stringify({ studentFeedback: 'Scale', score: null, scaleGrade: 'Achieved' });
    const custom = await (await fetch(`${ai.baseUrl}/api/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ content: 'system' }, { content: 'MARKER' }] }) })).json();
    assert.equal(JSON.parse(custom.message.content).scaleGrade, 'Achieved');
    ai.state.content = null;
    assert.equal((await fetch(`${ai.baseUrl}/api/tags`, { headers: { Origin: 'chrome-extension://fictional' } })).status, 403);
    console.log('PASS: the fake Ollama server lists the model, returns a fixed or a set correction, records the request and rejects browser origins.');
    const reply = await insecureGet(`https://127.0.0.1:${port}/login/index.php?x=1`, 10_000);
    const echoed = JSON.parse(reply.body);
    assert.equal(echoed.host, `127.0.0.1:${port}`);
    assert.equal(echoed.proto, 'https');
    assert.equal(echoed.url, '/login/index.php?x=1');
    assert.deepEqual(reply.headers['set-cookie'], ['A=1; Path=/', 'B=2; Path=/']);
    console.log('PASS: the TLS proxy keeps the public host, adds X-Forwarded-Proto and keeps every Set-Cookie header.');
    const fixture = { cmid: 1, student: { id: 2 }, locked_student: { id: 3 }, submission_file: 'a.pdf', markers: {},
      teacher: { username: 't', password: 'p' }, teacher_editor: 'tiny',
      guide: { cmid: 4, criteria: [{ id: 11, dom_id: 'advancedgrading-criteria-11', shortname: 'Content', max_score: 6 }] },
      scale: { cmid: 5, items: ['Not yet', 'Achieved'] } };
    const config = await readConfig({ MOODLE_URL: 'https://127.0.0.1:18443', MOODLE_UPSTREAM: 'http://127.0.0.1:18080',
      MOODLE_LAB_FIXTURE_JSON: `log line\n${JSON.stringify(fixture)}` });
    assert.equal(config.username, 't');
    assert.equal(config.fixture.guide.criteria[0].dom_id, 'advancedgrading-criteria-11');
    await assert.rejects(readConfig({ MOODLE_URL: 'https://127.0.0.1:18443', MOODLE_LAB_FIXTURE_JSON: JSON.stringify({ ...fixture, guide: undefined }) }),
      /no "guide"; create it again/);
    await assert.rejects(readConfig({ MOODLE_URL: 'https://127.0.0.1:18443', MOODLE_LAB_FIXTURE_JSON: JSON.stringify({ ...fixture, scale: { cmid: 5, items: [] } }) }),
      /"scale" needs/);
    await assert.rejects(readConfig({ MOODLE_URL: 'http://127.0.0.1:18080' }), /must use https[\s\S]*MOODLE_LAB_FIXTURE/);
    await assert.rejects(readConfig({ MOODLE_URL: 'https://127.0.0.1', MOODLE_UPSTREAM: 'http://127.0.0.1:18080', MOODLE_LAB_FIXTURE_JSON: '{}' }), /port other than 443/);
    console.log('PASS: configuration parsing accepts the last JSON line and explains invalid settings.');
  } finally {
    await Promise.all([ai.server, stub, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
    await fs.rm(certificate.directory, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Browser helpers.

const panelSelector = '#mca-side-panel-host';
const panelStatus = (page) => page.evaluate(() => document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-status]')?.textContent || '');

// Feedback lives in a textarea that TinyMCE (4.5+) or Atto mirror in an editor.
const readFeedback = (page) => page.evaluate(() => {
  const area = document.querySelector('textarea[name="assignfeedbackcomments_editor[text]"]');
  const frame = document.getElementById('id_assignfeedbackcomments_editor_ifr');
  const editable = document.getElementById('id_assignfeedbackcomments_editoreditable');
  let tiny = '';
  try { tiny = window.tinymce?.get?.('id_assignfeedbackcomments_editor')?.getContent?.() || ''; } catch { tiny = ''; }
  return [area?.value, frame?.contentDocument?.body?.innerHTML, editable?.innerHTML, tiny].filter(Boolean).join('\n');
});

const gradeInputValue = (page) => page.evaluate(() => {
  const input = [...document.querySelectorAll('#id_grade, input[name="grade"]')].find((element) => ['text', 'number'].includes(element.type));
  return input ? input.value : null;
});

const waitForGradingForm = async (page, timeoutMs) => {
  await page.waitForFunction(() => document.querySelector('textarea[name="assignfeedbackcomments_editor[text]"]'), null, { timeout: timeoutMs })
    .catch(() => { throw new Error(`Moodle's grading form (feedback comments field) did not load within ${timeoutMs} ms on ${page.url()}.`); });
};

// TinyMCE only: the editor iframe's body and the TinyMCE API, never the textarea it mirrors.
const readTinyFeedback = (page) => page.evaluate(() => {
  const id = document.querySelector('textarea[name="assignfeedbackcomments_editor[text]"]')?.id || 'id_assignfeedbackcomments_editor';
  const body = document.getElementById(`${id}_ifr`)?.contentDocument?.body?.innerHTML || '';
  let api = '';
  try { api = window.tinymce?.get?.(id)?.getContent?.() || ''; } catch { api = ''; }
  return [body, api].filter(Boolean).join('\n');
});

const waitForTinyMce = async (page, timeoutMs) => {
  try {
    await page.waitForFunction(() => {
      const id = document.querySelector('textarea[name="assignfeedbackcomments_editor[text]"]')?.id;
      return document.getElementById(`${id}_ifr`)?.contentDocument?.body?.getAttribute('contenteditable') === 'true';
    }, null, { timeout: timeoutMs });
  } catch {
    const found = await page.evaluate(() => {
      const area = document.querySelector('textarea[name="assignfeedbackcomments_editor[text]"]');
      return { textareaId: area?.id || null, tinyContainers: document.querySelectorAll('.tox-tinymce').length,
        atto: Boolean(document.querySelector('.editor_atto')), textareaVisible: Boolean(area && area.offsetParent) };
    }).catch(() => ({}));
    throw new Error(`TinyMCE did not load for the feedback comments within ${timeoutMs} ms on ${page.url()} (${JSON.stringify(found)}). The fixture made TinyMCE the teacher's editor.`);
  }
};

// Polls read() until accept(value) holds; every wait is bounded by timeoutMs.
const waitForValue = async (read, accept, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read().catch((error) => `(error: ${error.message})`);
    if (accept(last)) return last;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description} within ${timeoutMs} ms; last value: ${JSON.stringify(last)?.slice(0, 400)}.`);
};

// The grade form's static "Current grade in gradebook" (assign's 'currentgrade' element).
const currentGradebookGrade = (page) => page.evaluate(() => {
  const item = document.getElementById('fitem_id_currentgrade') ||
    [...document.querySelectorAll('[data-region="grade"] .fitem, [data-region="grade"] .form-group')]
      .find((element) => /current grade in gradebook/i.test(element.textContent || ''));
  const value = item?.querySelector('.felement, [data-fieldtype="static"], .form-control-static') || item;
  return value ? value.textContent.replace(/\s+/g, ' ').trim() : null;
});

const lastNumber = (text) => {
  const numbers = String(text ?? '').match(/\d+(?:[.,]\d+)?/g);
  return numbers ? Number(numbers.at(-1).replace(',', '.')) : NaN;
};

const selectedScaleLabel = (page) => page.evaluate(() => {
  const select = document.querySelector('select#id_grade, select[name="grade"]');
  return select ? select.options[select.selectedIndex]?.textContent.replace(/\s+/g, ' ').trim() ?? null : null;
});

const readGuideInputs = (page, criteria) => page.evaluate((ids) => ids.map((id) => ({
  id,
  score: document.querySelector(`input[name="advancedgrading[criteria][${id}][score]"]`)?.value ?? null,
  remark: document.querySelector(`textarea[name="advancedgrading[criteria][${id}][remark]"]`)?.value ?? null,
})), criteria.map((criterion) => criterion.id));

const waitForGuideInputs = async (page, criteria, timeoutMs) => {
  await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`input[name="advancedgrading[criteria][${id}][score]"]`)),
    criteria.map((criterion) => criterion.id), { timeout: timeoutMs })
    .catch(() => { throw new Error(`Moodle's marking guide score inputs (criteria ${criteria.map((criterion) => criterion.id).join(', ')}) did not load within ${timeoutMs} ms on ${page.url()}.`); });
};

const waitForPanelStatus = async (page, expected, timeoutMs, description) => {
  try {
    await page.waitForFunction((text) => (document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-status]')?.textContent || '').includes(text), expected, { timeout: timeoutMs });
  } catch {
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description} ("${expected}"); panel status: "${await panelStatus(page)}".`);
  }
};

// Clicks a panel action and waits until it either succeeds or ends with any other status.
const runPanelAction = async (page, selector, success, timeoutMs, description) => {
  const before = await panelStatus(page);
  await page.locator(`${panelSelector} ${selector}`).click();
  const outcome = await page.waitForFunction(({ success, before }) => {
    const root = document.querySelector('#mca-side-panel-host')?.shadowRoot;
    const status = root?.querySelector('[data-status]')?.textContent || '';
    const busy = root?.querySelector('[data-correct]')?.disabled;
    if (success.some((text) => status.includes(text))) return { status };
    if (!busy && status && status !== before && !/Requesting AI correction/.test(status)) return { status };
    return false;
  }, { success, before }, { timeout: timeoutMs, polling: 250 }).then((handle) => handle.jsonValue()).catch(async () => ({ status: await panelStatus(page), timedOut: true }));
  if (outcome.timedOut) throw new Error(`${description} did not finish within ${timeoutMs} ms; panel status: "${outcome.status}".`);
  return outcome.status;
};

const findMoodleTab = (driver, origin) => driver.evaluate(async (origin) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => (candidate.url || '').startsWith(`${origin}/mod/assign/view.php`));
  return tab?.id ?? null;
}, origin);

const openPanel = async (page, timeoutMs) => {
  await page.locator('#mca-floating-button-host').waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => {
    throw new Error(`The extension did not inject its assistant into ${page.url()} within ${timeoutMs} ms (remembered-site content script missing).`);
  });
  if (!(await page.evaluate(() => document.documentElement.classList.contains('mca-panel-open')))) await page.locator('#mca-floating-button-host button').click();
  await waitForPanelStatus(page, STATUS_READY, timeoutMs * 2, 'the panel to detect the assignment');
};

// Closes the panel, presses Moodle's "Save changes" and checks the web service reply.
const saveGradingForm = async (page, timeoutMs, description) => {
  if (await page.evaluate(() => document.documentElement.classList.contains('mca-panel-open'))) {
    await page.locator(`${panelSelector} [data-close]`).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('mca-panel-open'), null, { timeout: timeoutMs });
  }
  const notify = page.locator('input[type="checkbox"][name="sendstudentnotifications"]');
  if (await notify.count() && await notify.first().isChecked()) await notify.first().uncheck();
  const saved = page.waitForResponse((response) => response.url().includes('/lib/ajax/service.php') &&
    `${response.url()} ${response.request().postData() || ''}`.includes('mod_assign_submit_grading_form'), { timeout: timeoutMs });
  await page.locator('button[name="savechanges"]').first().click();
  const saveResponse = await saved.catch(() => { throw new Error(`Moodle did not answer "Save changes" for ${description} within ${timeoutMs} ms.`); });
  const saveResult = await saveResponse.json().catch(() => null);
  assert.ok(Array.isArray(saveResult) && saveResult[0] && saveResult[0].error === false,
    `Moodle rejected the grading form for ${description}: ${JSON.stringify(saveResult)?.slice(0, 500)}`);
  assert.deepEqual(saveResult[0].data || [], [], `Moodle returned warnings when saving ${description}: ${JSON.stringify(saveResult[0].data)}`);
};

const saveFailureArtifacts = async (context, artifacts) => {
  await fs.mkdir(artifacts, { recursive: true });
  for (const [index, page] of (context?.pages() || []).entries()) {
    if (page.isClosed()) continue;
    const name = `page-${index + 1}`;
    await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
    const details = await page.evaluate(() => ({
      url: location.href,
      status: document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-status]')?.textContent || null,
      diagnostics: document.querySelector('#mca-side-panel-host')?.shadowRoot?.querySelector('[data-diagnostics]')?.textContent || null,
    })).catch((error) => ({ error: error.message }));
    await fs.writeFile(path.join(artifacts, `${name}.json`), JSON.stringify(details, null, 2)).catch(() => {});
    await fs.writeFile(path.join(artifacts, `${name}.html`), await page.content().catch(() => '')).catch(() => {});
  }
};

// ---------------------------------------------------------------------------

const main = async () => {
  const config = await readConfig();
  const { fixture, moodleUrl, timeoutMs, aiTimeoutMs } = config;
  try { await fs.access(path.join(extensionPath, 'src', 'i18nMessages.js')); }
  catch { throw new Error('The extension is not built: run "npm run build" first.'); }
  const { chromium } = await import('playwright');
  const logLines = [];
  const log = (line) => { logLines.push(`${new Date().toISOString()} ${line}`); };
  const servers = [];
  let certificateDirectory = null;
  let context;
  try {
    const ai = await startFakeAi();
    servers.push(ai.server);
    if (config.upstream) {
      let certificate;
      if (config.tlsCert) certificate = { cert: await fs.readFile(config.tlsCert), key: await fs.readFile(config.tlsKey) };
      else { certificate = await createSelfSignedCertificate(new URL(moodleUrl).hostname.replace(/^\[|\]$/g, '')); certificateDirectory = certificate.directory; }
      servers.push(await startTlsProxy({ listen: new URL(moodleUrl), upstream: config.upstream, ...certificate }));
      console.log(`INFO: TLS proxy ${moodleUrl} -> ${config.upstream.origin}`);
    }
    await waitForMoodle(moodleUrl, config.readyTimeoutMs);
    console.log(`INFO: Moodle ${fixture.moodle_release || '(release unknown)'} answers at ${moodleUrl}.`);

    context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: !config.headed, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--ignore-certificate-errors'],
    });
    context.setDefaultTimeout(timeoutMs);
    context.on('page', (page) => {
      page.on('pageerror', (error) => log(`pageerror ${page.url()}: ${error.message}`));
      page.on('console', (message) => { if (message.type() === 'error') log(`console ${page.url()}: ${message.text()}`); });
      page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: timeoutMs });
    const extensionId = worker.url().split('/')[2];
    await worker.evaluate(() => chrome.storage.local.set({ 'mca.uiLanguage': 'en' }));

    // Configure the fake AI from an extension page, as the options page does.
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    const send = (message) => driver.evaluate((value) => MoodliaCorrectorRuntime.send(value), message);
    await send({ type: 'mca.setAiRuntimeConfig', config: { provider: 'ollama', baseUrl: ai.baseUrl, model: AI_MODEL } });
    const connection = await send({ type: 'mca.testAiConnection' });
    assert.equal(connection?.ok, true, `The extension could not reach the fake AI: ${connection?.error}`);
    console.log('PASS: the built extension loads in Chromium and verifies the fake local AI server.');

    // Sign in as the fixture teacher.
    const page = await context.newPage();
    await page.goto(`${moodleUrl}/login/index.php`);
    await page.locator('#username').fill(config.username);
    await page.locator('#password').fill(config.password);
    await page.locator('#loginbtn').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login/'), { timeout: timeoutMs }).catch(async () => {
      const message = await page.locator('.loginerrors, #loginerrormessage, .alert-danger').first().textContent({ timeout: 1000 }).catch(() => '');
      throw new Error(`Signing in as "${config.username}" failed at ${page.url()}${message ? `: ${message.trim()}` : ''}.`);
    });
    console.log(`PASS: the teacher "${config.username}" signs in to the real Moodle site.`);

    const graderUrlFor = (cmid, userId) => `${moodleUrl}/mod/assign/view.php?id=${cmid}&action=grader&userid=${userId}`;
    const graderUrl = (userId) => graderUrlFor(fixture.cmid, userId);
    const expectTiny = fixture.teacher_editor === 'tiny';
    const extract = async (tabId) => {
      const reply = await driver.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'mca.extractAssignment' }), tabId);
      assert.equal(reply?.ok, true, `Assignment extraction failed on ${page.url()}: ${reply?.error}`);
      return reply.assignmentData;
    };
    const waitForAssistant = () => page.locator('#mca-floating-button-host').waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => {
      throw new Error(`The remembered-site content script did not inject the assistant into ${page.url()}.`);
    });
    const waitForTinyFeedback = (pattern, description) => waitForValue(() => readTinyFeedback(page), (value) => pattern.test(value),
      timeoutMs, `${description}: TinyMCE did not show ${pattern}`);
    // Remember the site through the extension's own activation message.
    const activation = await send({ type: 'mca.setAutomaticActivation', url: graderUrl(fixture.student.id), enabled: true });
    assert.equal(activation?.ok, true, `Remembering the site failed: ${activation?.error}`);
    const registered = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).flatMap((script) => script.matches));
    assert.ok(registered.some((match) => match.startsWith(moodleUrl)), `No content script is registered for ${moodleUrl}: ${JSON.stringify(registered)}`);
    console.log(`PASS: the extension remembers ${moodleUrl} and registers its grader content script.`);

    // Student 1: detection, AI correction, save and reload.
    await page.goto(graderUrl(fixture.student.id));
    await waitForGradingForm(page, timeoutMs * 2);
    if (expectTiny) await waitForTinyMce(page, timeoutMs);
    assert.notEqual(await gradeInputValue(page), null, 'The first student has no editable grade input; check the fixture.');
    await waitForAssistant();
    const tabId = await findMoodleTab(driver, moodleUrl);
    assert.ok(tabId !== null, 'The grader tab is not visible to the extension.');
    const data = await extract(tabId);
    assert.match(data.assignmentPrompt || '', new RegExp(fixture.markers.intro), 'The assignment statement was not detected.');
    assert.match(data.submissionText || '', new RegExp(fixture.markers.onlinetext), 'The online text submission was not detected.');
    assert.equal(data.submissionFiles?.length, 1, `Expected one submission file, got ${JSON.stringify(data.submissionFiles)}.`);
    assert.match(data.submissionFiles[0].url, /\/pluginfile\.php\/\d+\/assignsubmission_file\/submission_files\//);
    assert.equal(data.maxScore, Number(fixture.max_grade ?? 10));
    assert.equal(data.correctionMethod, 'simple-direct');
    assert.equal(data.gradingControls?.grade, true);
    assert.equal(data.gradingControls?.finalFeedback, true);
    console.log(`PASS: on Moodle's grader the extension detects the statement, online text, ${fixture.submission_file}, the grade out of ${data.maxScore} and the feedback editor (${data.gradingControls.finalFeedbackType}).`);

    await openPanel(page, timeoutMs);
    const submissionPreview = page.locator(`${panelSelector} [data-file-preview] [data-file-role="student-submission"]`);
    assert.match(await submissionPreview.first().textContent(), new RegExp(fixture.submission_file.replace('.', '\\.')));
    console.log('PASS: the panel opens and lists the submitted file for the correction.');

    ai.state.chats.length = 0;
    ai.state.feedback = `Fictional lab review MCALABFEEDBACKONE: the explanation is clear.`;
    ai.state.score = 8;
    const firstStatus = await runPanelAction(page, '[data-correct]', [STATUS_APPLIED], aiTimeoutMs, 'The AI correction');
    assert.equal(firstStatus, STATUS_APPLIED, `Unexpected panel status after the correction: "${firstStatus}".`);
    const sentToAi = ai.state.chats.join('\n');
    assert.ok(ai.state.chats.length > 0, 'The fake AI received no correction request.');
    assert.ok(sentToAi.includes(fixture.markers.pdf), 'The text of the submitted PDF did not reach the AI: the pluginfile.php download with the teacher session failed or was not read.');
    assert.ok(sentToAi.includes(fixture.markers.onlinetext), 'The online text did not reach the AI.');
    assert.ok(sentToAi.includes(fixture.markers.intro), 'The assignment statement did not reach the AI.');
    console.log('PASS: the AI request carries the statement, the online text and the PDF text downloaded from pluginfile.php with the teacher session.');
    assert.equal(Number(String(await gradeInputValue(page)).replace(',', '.')), 8, 'The grade input was not filled.');
    assert.match(await readFeedback(page), /MCALABFEEDBACKONE/, 'The feedback editor was not filled.');
    if (expectTiny) await waitForTinyFeedback(/MCALABFEEDBACKONE/, 'After the correction');
    console.log(`PASS: the correction fills Moodle's grade input and ${expectTiny ? 'the TinyMCE feedback editor' : 'feedback editor'} and the panel reports it applied.`);
    await page.screenshot({ path: path.join(config.artifacts, 'student-applied.png') }).catch(() => {});

    await saveGradingForm(page, timeoutMs, 'the simple assignment');
    await page.reload();
    await waitForGradingForm(page, timeoutMs * 2);
    assert.equal(Number(String(await gradeInputValue(page)).replace(',', '.')), 8, 'The saved grade did not persist after reloading the grader.');
    assert.match(await readFeedback(page), /MCALABFEEDBACKONE/, 'The saved feedback did not persist after reloading the grader.');
    if (expectTiny) {
      await waitForTinyMce(page, timeoutMs);
      await waitForTinyFeedback(/MCALABFEEDBACKONE/, 'After saving and reloading');
    }
    console.log(`PASS: Moodle's "Save changes" stores the applied grade and feedback, and both survive a reload${expectTiny ? ' (feedback shown again in TinyMCE)' : ''}.`);

    // Student 2: grade overridden and locked in the gradebook.
    await page.goto(graderUrl(fixture.locked_student.id));
    await waitForGradingForm(page, timeoutMs * 2);
    assert.equal(await gradeInputValue(page), null, 'The overridden student still has an editable grade input; check the fixture.');
    await openPanel(page, timeoutMs);
    ai.state.chats.length = 0;
    ai.state.feedback = 'Fictional lab review MCALABFEEDBACKTWO for an overridden grade.';
    const lockedStatus = await runPanelAction(page, '[data-correct]', [STATUS_GRADE_NOT_APPLIED], aiTimeoutMs, 'The AI correction of the overridden student');
    assert.ok(ai.state.chats.length > 0, 'The fake AI received no correction request for the overridden student.');
    assert.match(await readFeedback(page), /MCALABFEEDBACKTWO/, 'The feedback editor of the overridden student was not filled.');
    assert.equal(await gradeInputValue(page), null);
    assert.ok(lockedStatus.includes(STATUS_GRADE_NOT_APPLIED), `Unexpected status for the overridden student: "${lockedStatus}".`);
    console.log('PASS: for the overridden student the AI correction fills the feedback and reports that the grade was not applied.');

    if (!(await page.locator(`${panelSelector} [data-external-correction]`).isVisible())) { await page.locator(`${panelSelector} [data-more]`).click(); await page.locator(`${panelSelector} [data-tool="json"]`).click(); }
    await page.locator(`${panelSelector} [data-external-correction]`).fill(JSON.stringify({ studentFeedback: 'Fictional pasted review MCALABFEEDBACKTHREE.', score: 5 }));
    const pastedStatus = await runPanelAction(page, '[data-apply-correction]', [STATUS_GRADE_NOT_APPLIED], timeoutMs, 'Applying a pasted correction');
    assert.ok(pastedStatus.includes(STATUS_GRADE_NOT_APPLIED), `Unexpected status for the overridden student: "${pastedStatus}".`);
    assert.match(await readFeedback(page), /MCALABFEEDBACKTHREE/);
    assert.equal(await gradeInputValue(page), null);
    console.log('PASS: a pasted correction with a score for the overridden student applies the feedback and says the grade was not applied.');
    await page.screenshot({ path: path.join(config.artifacts, 'locked-student.png') }).catch(() => {});

    // Marking guide: the AI returns one score and remark per criterion; the
    // gradebook grade is their sum (the fixture's maxima add up to its max grade).
    const guide = fixture.guide;
    await page.goto(graderUrlFor(guide.cmid, fixture.student.id));
    await waitForGradingForm(page, timeoutMs * 2);
    await waitForGuideInputs(page, guide.criteria, timeoutMs);
    if (expectTiny) await waitForTinyMce(page, timeoutMs);
    await waitForAssistant();
    const guideData = await extract(tabId);
    assert.equal(guideData.correctionMethod, 'grading-guide', `The guide assignment was detected as "${guideData.correctionMethod}".`);
    assert.deepEqual(guideData.gradingGuide.map(({ id, maxScore }) => ({ id, maxScore })),
      guide.criteria.map((criterion) => ({ id: criterion.dom_id, maxScore: criterion.max_score })), 'The detected guide criteria differ from the fixture.');
    assert.equal(guideData.gradingControls?.guideCriteriaWithScoreInputs, guide.criteria.length);
    assert.equal(guideData.gradingControls?.finalFeedback, true);
    if (fixture.markers.guide_text) assert.match(guideData.submissionText || '', new RegExp(fixture.markers.guide_text), 'The guide online text was not detected.');
    console.log(`PASS: the extension detects the marking guide (${guide.criteria.map((criterion) => `${criterion.shortname || criterion.id} /${criterion.max_score}`).join(', ')}) on Moodle's grader.`);

    const guideScores = guide.criteria.map((criterion, index) => ({
      criterionId: criterion.dom_id,
      score: Math.max(0, Math.floor(criterion.max_score) - 1 - index),
      remark: `Fictional remark MCALABREMARK${index + 1} for this criterion.`,
    }));
    const guideSum = guideScores.reduce((sum, entry) => sum + entry.score, 0);
    await openPanel(page, timeoutMs);
    ai.state.chats.length = 0;
    ai.state.content = JSON.stringify({ studentFeedback: 'Fictional guide review MCALABFEEDBACKGUIDE.', score: null, maxScore: null, rubricSelections: [], guideScores });
    const guideStatus = await runPanelAction(page, '[data-correct]', [STATUS_APPLIED], aiTimeoutMs, 'The AI correction of the guide assignment')
      .finally(() => { ai.state.content = null; });
    assert.equal(guideStatus, STATUS_APPLIED, `Unexpected panel status after the guide correction: "${guideStatus}".`);
    assert.ok(ai.state.chats.length > 0, 'The fake AI received no correction request for the guide assignment.');
    assert.ok(ai.state.chats.some((body) => body.includes('guideScores')), 'The AI request for the guide assignment does not ask for guideScores.');
    if (fixture.markers.guide_text) assert.ok(ai.state.chats.join('\n').includes(fixture.markers.guide_text), 'The guide online text did not reach the AI.');
    const assertGuideInputs = async (when) => {
      const inputs = await readGuideInputs(page, guide.criteria);
      for (const [index, input] of inputs.entries()) {
        assert.equal(Number(String(input.score ?? '').replace(',', '.')), guideScores[index].score,
          `${when}: the score of guide criterion ${input.id} is "${input.score}", expected ${guideScores[index].score}.`);
        assert.match(input.remark || '', new RegExp(`MCALABREMARK${index + 1}`), `${when}: the remark of guide criterion ${input.id} is "${input.remark}".`);
      }
    };
    await assertGuideInputs('After the correction');
    if (expectTiny) await waitForTinyFeedback(/MCALABFEEDBACKGUIDE/, 'After the guide correction');
    else assert.match(await readFeedback(page), /MCALABFEEDBACKGUIDE/, 'The guide feedback editor was not filled.');
    console.log(`PASS: the guide correction fills every criterion score and remark (sum ${guideSum}) and the feedback, and the panel reports it applied.`);
    await page.screenshot({ path: path.join(config.artifacts, 'guide-applied.png') }).catch(() => {});

    await saveGradingForm(page, timeoutMs, 'the guide assignment');
    await page.reload();
    await waitForGradingForm(page, timeoutMs * 2);
    await waitForGuideInputs(page, guide.criteria, timeoutMs);
    await assertGuideInputs('After saving and reloading');
    if (expectTiny) { await waitForTinyMce(page, timeoutMs); await waitForTinyFeedback(/MCALABFEEDBACKGUIDE/, 'After saving and reloading the guide assignment'); }
    else assert.match(await readFeedback(page), /MCALABFEEDBACKGUIDE/, 'The saved guide feedback did not persist after reloading.');
    await waitForValue(() => currentGradebookGrade(page), (value) => Math.abs(lastNumber(value) - guideSum) < 0.005, timeoutMs,
      `The gradebook grade of the guide assignment ("Current grade in gradebook") did not become ${guideSum}`);
    console.log(`PASS: Moodle saves the guide scores, remarks and feedback, and the gradebook grade is their sum (${guideSum}) after a reload.`);

    // Scale: the AI returns one of the scale's item labels for Moodle's grade select.
    const scale = fixture.scale;
    const scaleChoice = scale.items[Math.min(2, scale.items.length - 1)];
    await page.goto(graderUrlFor(scale.cmid, fixture.student.id));
    await waitForGradingForm(page, timeoutMs * 2);
    await page.waitForFunction(() => document.querySelector('select#id_grade, select[name="grade"]')?.options.length > 1, null, { timeout: timeoutMs })
      .catch(() => { throw new Error(`Moodle's scale grade select did not load within ${timeoutMs} ms on ${page.url()}.`); });
    if (expectTiny) await waitForTinyMce(page, timeoutMs);
    await waitForAssistant();
    const scaleData = await extract(tabId);
    assert.equal(scaleData.gradingControls?.gradeScale, true, 'The scale grade select was not detected.');
    // Moodle's grader lists scale items from the highest down.
    assert.deepEqual((scaleData.gradeScaleOptions || []).map((option) => option.label).sort(), [...scale.items].sort(), 'The detected scale items differ from the fixture.');
    if (fixture.markers.scale_text) assert.match(scaleData.submissionText || '', new RegExp(fixture.markers.scale_text), 'The scale online text was not detected.');
    console.log(`PASS: the extension detects the scale grade (${scale.items.join(', ')}) on Moodle's grader.`);

    await openPanel(page, timeoutMs);
    ai.state.chats.length = 0;
    ai.state.content = JSON.stringify({ studentFeedback: 'Fictional scale review MCALABFEEDBACKSCALE.', score: null, maxScore: null, rubricSelections: [], scaleGrade: scaleChoice });
    const scaleStatus = await runPanelAction(page, '[data-correct]', [STATUS_APPLIED], aiTimeoutMs, 'The AI correction of the scale assignment')
      .finally(() => { ai.state.content = null; });
    assert.equal(scaleStatus, STATUS_APPLIED, `Unexpected panel status after the scale correction: "${scaleStatus}".`);
    assert.ok(ai.state.chats.some((body) => body.includes('scaleGrade')), 'The AI request for the scale assignment does not ask for scaleGrade.');
    assert.equal(await selectedScaleLabel(page), scaleChoice, 'The scale select does not show the AI choice.');
    if (expectTiny) await waitForTinyFeedback(/MCALABFEEDBACKSCALE/, 'After the scale correction');
    else assert.match(await readFeedback(page), /MCALABFEEDBACKSCALE/, 'The scale feedback editor was not filled.');
    console.log(`PASS: the scale correction selects "${scaleChoice}" and fills the feedback, and the panel reports it applied.`);
    await page.screenshot({ path: path.join(config.artifacts, 'scale-applied.png') }).catch(() => {});

    await saveGradingForm(page, timeoutMs, 'the scale assignment');
    await page.reload();
    await waitForGradingForm(page, timeoutMs * 2);
    await waitForValue(() => selectedScaleLabel(page), (value) => value === scaleChoice, timeoutMs,
      `After saving and reloading, the scale select did not show "${scaleChoice}"`);
    if (expectTiny) { await waitForTinyMce(page, timeoutMs); await waitForTinyFeedback(/MCALABFEEDBACKSCALE/, 'After saving and reloading the scale assignment'); }
    else assert.match(await readFeedback(page), /MCALABFEEDBACKSCALE/, 'The saved scale feedback did not persist after reloading.');
    await waitForValue(() => currentGradebookGrade(page), (value) => String(value ?? '').includes(scaleChoice), timeoutMs,
      `The gradebook grade of the scale assignment ("Current grade in gradebook") did not become "${scaleChoice}"`);
    console.log(`PASS: Moodle saves the scale grade "${scaleChoice}" and the feedback, and both survive a reload.`);
  } catch (error) {
    await saveFailureArtifacts(context, config.artifacts).catch(() => {});
    error.message += `\nArtifacts: ${config.artifacts}`;
    throw error;
  } finally {
    await fs.mkdir(config.artifacts, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(config.artifacts, 'browser.log'), logLines.join('\n') + '\n').catch(() => {});
    await context?.close().catch(() => {});
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (certificateDirectory) await fs.rm(certificateDirectory, { recursive: true, force: true }).catch(() => {});
  }
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) console.log(usage);
else {
  const unknown = args.filter((argument) => !['--self-test'].includes(argument));
  if (unknown.length) { console.error(`Unknown argument: ${unknown.join(' ')}\n\n${usage}`); process.exitCode = 2; }
  else {
    try { await (args.includes('--self-test') ? selfTest() : main()); }
    catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
  }
}
