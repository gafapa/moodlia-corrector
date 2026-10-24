import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';

const root = path.resolve('.');
const run = (script, cwd) => spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd, encoding: 'utf8' });

test('store validation rejects the removed provider list in every locale', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'corrector-store-validation-'));
  try {
    await fs.cp('marketplace', path.join(folder, 'marketplace'), { recursive: true });
    await fs.mkdir(path.join(folder, 'extension'), { recursive: true });
    await fs.copyFile('extension/manifest.json', path.join(folder, 'extension/manifest.json'));
    await fs.cp('extension/_locales', path.join(folder, 'extension/_locales'), { recursive: true });
    assert.equal(run('validate-store-materials.mjs', folder).status, 0);
    for (const locale of ['en', 'es', 'fr', 'de', 'pt_BR', 'it', 'gl', 'ca']) {
      const file = path.join(folder, `marketplace/listings/${locale}.json`);
      const original = await fs.readFile(file);
      const listing = JSON.parse(original);
      listing.detailedDescription += '\nOllama, LM Studio, llama.cpp, LocalAI, vLLM, OpenAI';
      await fs.writeFile(file, JSON.stringify(listing));
      const result = run('validate-store-materials.mjs', folder);
      assert.notEqual(result.status, 0, locale);
      assert.match(result.stderr, /Rejected provider-brand enumeration/);
      await fs.writeFile(file, original);
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('copy-page regeneration refreshes stale listings and preserves publisher edits before writing', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'corrector-store-page-'));
  try {
    await fs.mkdir(path.join(folder, 'extension'), { recursive: true });
    await fs.mkdir(path.join(folder, 'release'), { recursive: true });
    await fs.writeFile(path.join(folder, 'extension/manifest.json'), JSON.stringify({ version: '0.0.1' }));
    const files = {
      'README.md': 'Fixture submission guide',
      'listings/en.json': JSON.stringify({ detailedDescription: 'Old fixture description' }),
      'documents/validation.json': JSON.stringify({ unit_tests_passed: 1, browser_checks_passed: 1, locale_browser_checks_passed: 1 }),
      'documents/dashboard-fields.md': '## Single purpose\nFixture purpose\n',
      'documents/privacy-policy.md': 'Fixture privacy',
      'documents/reviewer-instructions.md': 'Fixture reviewer instructions',
    };
    const writeKit = async () => {
      const entries = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
      entries['SHA256SUMS.txt'] = Buffer.from(Object.entries(entries).map(([name, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n');
      await fs.writeFile(path.join(folder, 'release/moodlia-corrector-submission-kit-0.0.1.zip'), zipSync(entries));
    };
    await writeKit();
    assert.equal(run('generate-submission-page.mjs', folder).status, 0);
    files['listings/en.json'] = JSON.stringify({ detailedDescription: 'Corrected fixture description' });
    await writeKit();
    assert.equal(run('generate-submission-page.mjs', folder).status, 0);
    const pageFolder = path.join(folder, 'release/publicar-moodlia-corrector-0.0.1');
    const html = await fs.readFile(path.join(pageFolder, 'index.html'));
    assert.ok(html.includes('Corrected fixture description'));
    const privateFile = path.join(pageFolder, 'documents/reviewer-instructions.md');
    await fs.writeFile(privateFile, 'Publisher-edited fictional access');
    files['listings/en.json'] = JSON.stringify({ detailedDescription: 'Another fixture update' });
    await writeKit();
    const result = run('generate-submission-page.mjs', folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Publisher-edited file preserved/);
    assert.equal(await fs.readFile(privateFile, 'utf8'), 'Publisher-edited fictional access');
    assert.deepEqual(await fs.readFile(path.join(pageFolder, 'index.html')), html);
    assert.ok((await fs.readFile(path.join(pageFolder, 'listings/en.json'), 'utf8')).includes('Corrected fixture description'));
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
