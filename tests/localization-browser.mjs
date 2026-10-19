import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
const source = {};
vm.runInNewContext(await fs.readFile('extension/src/i18nMessages.js', 'utf8'), source);
const data = source.MoodliaCorrectorMessages;
const expected = (locale, text) => data.catalogs[locale][data.aliases[text]].message;
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  viewport: { width: 1280, height: 800 }, args: [`--disable-extensions-except=${path.resolve('extension')}`, `--load-extension=${path.resolve('extension')}`] });
context.setDefaultTimeout(12000);
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${id}/src/popup/popup.html`);
  const nativeMessageKey = data.aliases['Mode: $1 · $2'];
  const nativeMessage = await driver.evaluate(key => chrome.i18n.getMessage(key, ['EXAMPLE_A', 'EXAMPLE_B']), nativeMessageKey);
  assert.ok(nativeMessage.includes('EXAMPLE_A') && nativeMessage.includes('EXAMPLE_B'));
  assert.ok(!nativeMessage.includes('$value'));
  assert.equal(await driver.evaluate(() => chrome.runtime.getManifest().name), 'MoodlIA Corrector');
  console.log('PASS: Chrome loads localized manifest metadata and resolves native message placeholders.');
  const fixture = await fs.readFile('tests/fixtures/store-grader.html', 'utf8');
  await context.route('https://store-moodle.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  for (const locale of data.locales) {
    await driver.evaluate(locale => chrome.storage.local.set({ 'mca.uiLanguage': locale }), locale);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    await popup.waitForFunction(locale => document.documentElement.lang === locale.replace('_', '-'), locale);
    assert.equal(await popup.locator('#add-site').textContent(), expected(locale, 'Add site'));
    assert.equal(await popup.locator('#manage-sites').textContent(), expected(locale, 'Manage sites'));
    await popup.locator('#add-site').click();
    assert.equal(await popup.locator('#site-url').getAttribute('aria-describedby'), 'site-hint');
    await popup.close();
    const grader = await context.newPage();
    await grader.goto(`https://store-moodle.test/mod/assign/view.php?id=42&action=grader&userid=1`);
    await driver.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/i18nMessages.js', 'src/i18n.js', 'src/aiProviders.js', 'src/attachmentSupport.js', 'src/correctionSchema.js', 'src/savedInstructions.js', 'src/filePreview.js', 'src/content/moodleContent.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'mca.openPanel' });
    }, grader.url());
    const panel = grader.locator('#mca-side-panel-host');
    await panel.locator('[data-status]').filter({ hasText: expected(locale, 'Detected data ready.') }).waitFor();
    assert.equal(await panel.locator('h2.title').textContent(), expected(locale, 'Moodle Corrector'));
    assert.equal(await panel.locator('label[for="mca-course-instructions"]').textContent(), expected(locale, 'For the course'));
    assert.match(await panel.locator('[data-grading-mode]').textContent(), new RegExp(expected(locale, 'Simple direct grading')));
    await panel.locator('[data-course-instructions]').fill('Curso');
    assert.equal(await panel.locator('[data-course-instructions]').inputValue(), 'Curso');
    assert.match(await grader.locator('.assignsubmission_onlinetext').textContent(), /A pond contains producers/);
    assert.equal(await grader.locator('html').getAttribute('lang'), 'en');
    assert.equal(await grader.locator('#id_grade').inputValue(), '');
    assert.equal(await grader.locator('#id_assignfeedbackcomments_editor').inputValue(), '');
    await panel.locator('[data-course-instructions]').fill('Explain strengths and give one practical improvement.');
    await panel.locator('[data-assignment-instructions]').fill('Assess ecological relationships and the conservation measure.');
    if (['en', 'es', 'de'].includes(locale)) {
      await panel.locator('.content').evaluate(element => { element.scrollTop = 0; });
      await grader.screenshot({ path: `marketplace/screenshots/${locale}-01-correction.png` });
    }
    await panel.locator('[data-tool="settings"]').click();
    await panel.locator('[data-ai-mode="advanced"]').click();
    const advanced = grader.frameLocator('iframe[title]');
    await advanced.locator('#interface-language').waitFor();
    assert.equal(await advanced.locator('#interface-language').inputValue(), locale);
    assert.equal(await advanced.locator('label[for="interface-language"]').textContent(), expected(locale, 'Interface language'));
    if (['en', 'es', 'de'].includes(locale)) {
      await panel.locator('.content').evaluate(element => { element.scrollTop = 0; });
      await advanced.locator('main').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await grader.waitForTimeout(100);
      await grader.screenshot({ path: `marketplace/screenshots/${locale}-02-settings.png` });
    }
    console.log(`PASS: ${locale} localizes popup, grading panel and authorized advanced settings without modifying Moodle or teacher text.`);
    await grader.close();
  }
  assert.deepEqual(errors, []);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.locator('#interface-language').selectOption('de');
  await options.waitForFunction(() => document.documentElement.lang === 'de');
  assert.equal(await options.locator('#interface-language').inputValue(), 'de');
  await options.reload();
  await options.waitForFunction(() => document.documentElement.lang === 'de');
  console.log('PASS: language selection persists after changing and reloading settings.');
} finally { await context.close(); }
