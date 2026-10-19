import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const messagesSource = await fs.readFile('extension/src/i18nMessages.js', 'utf8');
const runtimeSource = await fs.readFile('extension/src/i18n.js', 'utf8');
const createRuntime = (browserLanguage, preference) => {
  const sandbox = { chrome: { i18n: { getUILanguage: () => browserLanguage }, storage: { local: { get: async () => ({ 'mca.uiLanguage': preference }) } } } };
  vm.runInNewContext(messagesSource + '\n' + runtimeSource, sandbox);
  return { api: sandbox.MoodliaCorrectorI18n, data: sandbox.MoodliaCorrectorMessages };
};
test('all eight native Chrome catalogs have complete message and placeholder parity', async () => {
  const { data } = createRuntime('en');
  for (const locale of data.locales) {
    const native = JSON.parse(await fs.readFile(`extension/_locales/${locale}/messages.json`, 'utf8'));
    assert.deepEqual(Object.keys(native).sort(), Object.keys(data.catalogs.en).sort());
    for (const [key, entry] of Object.entries(native)) {
      assert.ok(entry.message.trim());
      assert.ok(native.extensionDescription.message.length <= 132);
      for (const match of entry.message.matchAll(/\$(value\d+)\$/g)) assert.ok(entry.placeholders[match[1]]);
      const raw = entry.message.replace(/\$(value\d+)\$/g, (_, placeholder) => entry.placeholders[placeholder].content);
      assert.equal(raw, data.catalogs[locale][key].message);
    }
  }
});
test('browser language and saved override select an available interface locale', async () => {
  for (const [language, expected] of [['fr-CA', 'fr'], ['pt-PT', 'pt_BR'], ['pt-BR', 'pt_BR'], ['de-DE', 'de'], ['ca-ES', 'ca'], ['ja-JP', 'en']]) {
    const { api } = createRuntime(language);
    await api.init();
    assert.equal(api.locale, expected);
  }
  const { api } = createRuntime('en-US', 'gl');
  await api.init();
  assert.equal(api.locale, 'gl');
  assert.equal(api.t('Add site'), 'Engadir sitio');
});
test('translation interpolation preserves user text without recursive substitutions or markup processing', async () => {
  const { api } = createRuntime('de');
  await api.init();
  const untrusted = '<img src=x onerror=alert(1)> $2 Curso';
  assert.equal(api.t('Remove $1', [untrusted]), `${untrusted} entfernen`);
  assert.equal(api.message`Quitar ${untrusted}`, `${untrusted} entfernen`);
  assert.equal(api.t('UNRECOGNIZED_TECHNICAL_MESSAGE'), 'UNRECOGNIZED_TECHNICAL_MESSAGE');
});
test('each supported locale translates primary site, grading and provider controls', async () => {
  const { data } = createRuntime('en');
  for (const locale of data.locales) {
    const { api } = createRuntime('en', locale); await api.init();
    for (const source of ['Add site', 'Manage sites', 'Correct with AI', 'For the course', 'For the assignment', 'For this case', 'Advanced AI settings', 'Test connection', 'Interface language']) {
      assert.equal(api.t(source), data.catalogs[locale][data.aliases[source]].message);
      if (locale !== 'en') assert.notEqual(api.t(source), source);
    }
  }
});
