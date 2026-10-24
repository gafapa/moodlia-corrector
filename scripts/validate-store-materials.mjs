import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { unzipSync } from 'fflate';

const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
const version = manifest.version;
const locales = ['ca', 'de', 'en', 'es', 'fr', 'gl', 'it', 'pt_BR'];
// Project-specific protection against reintroducing the rejected brand enumeration.
// This is a regression check, not a general detector of keyword spam or store approval.
const providerBrands = /\b(?:Ollama|LM\s+Studio|llama\.cpp|LocalAI|vLLM|OpenAI)\b/i;
const listings = {};
for (const locale of locales) {
  const bytes = await fs.readFile(`marketplace/listings/${locale}.json`);
  const listing = JSON.parse(bytes);
  assert.equal(listing.locale, locale);
  assert.equal(listing.name, 'MoodlIA Corrector');
  assert.ok(listing.summary.trim().length > 0 && listing.summary.length <= 132, locale);
  assert.ok(listing.detailedDescription.trim().length > 0 && listing.detailedDescription.length <= 16000, locale);
  assert.ok(!providerBrands.test(`${listing.name}\n${listing.summary}\n${listing.detailedDescription}`), `Rejected provider-brand enumeration: ${locale}`);
  assert.equal(listing.homepage, 'https://moodlia.com/apps/corrector/');
  assert.equal(listing.privacyPolicyUrl, 'https://moodlia.com/privacy/corrector.html');
  const catalog = JSON.parse(await fs.readFile(`extension/_locales/${locale}/messages.json`, 'utf8'));
  assert.equal(listing.summary, catalog.extensionDescription.message);
  listings[`listings/${locale}.json`] = bytes;
}
for (const name of ['marketplace/SUBMISSION.md', 'marketplace/chrome-web-store-listing.md', 'marketplace/dashboard-fields.md', 'marketplace/reviewer-instructions.md']) {
  const text = await fs.readFile(name, 'utf8');
  assert.ok(text.includes(version), `Missing current version: ${name}`);
  assert.ok(!/0\.1\.67/.test(text), `Stale submission version: ${name}`);
}
console.log(`PASS: ${locales.length} localized listings and current submission documents; rejected provider enumeration absent.`);

if (process.argv.includes('--artifacts')) {
  const folder = path.resolve(`release/publicar-moodlia-corrector-${version}`);
  const kit = unzipSync(await fs.readFile(`release/moodlia-corrector-submission-kit-${version}.zip`));
  for (const [name, bytes] of Object.entries(listings)) {
    assert.deepEqual(Buffer.from(kit[name]), bytes, `Stale kit listing: ${name}`);
    assert.deepEqual(await fs.readFile(path.join(folder, name)), bytes, `Stale copy-page listing: ${name}`);
  }
  const html = await fs.readFile(path.join(folder, 'index.html'), 'utf8');
  const pageArchive = unzipSync(await fs.readFile(`release/moodlia-corrector-publishing-page-${version}.zip`));
  for (const [name, bytes] of Object.entries(pageArchive)) assert.deepEqual(Buffer.from(bytes), await fs.readFile(path.join(folder, name)), `Stale publishing-page archive: ${name}`);
  assert.equal(Object.keys(pageArchive).length, Object.keys(kit).length + 1);
  const embedded = JSON.parse(html.match(/<script id="submission-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  for (const locale of locales) assert.deepEqual(embedded.listings[locale], JSON.parse(listings[`listings/${locale}.json`]), `Stale embedded listing: ${locale}`);
  for (const name of ['dashboard-fields.md', 'reviewer-instructions.md', 'privacy-policy.md', 'privacy-policy.html']) {
    const source = await fs.readFile(`marketplace/${name}`);
    assert.deepEqual(Buffer.from(kit[`documents/${name}`]), source, `Stale kit document: ${name}`);
    assert.deepEqual(await fs.readFile(path.join(folder, 'documents', name)), source, `Stale copy-page document: ${name}`);
  }
  const extension = await fs.readFile(`release/moodlia-corrector-${version}.zip`);
  assert.deepEqual(Buffer.from(kit[`upload/moodlia-corrector-${version}.zip`]), extension);
  assert.deepEqual(await fs.readFile(path.join(folder, 'upload', `moodlia-corrector-${version}.zip`)), extension);
  for (const line of (await fs.readFile(path.join(folder, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')) {
    const [expected, name] = line.split('  ');
    const target = path.resolve(folder, name);
    assert.ok(target.startsWith(folder + path.sep));
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex'), expected, name);
  }
  console.log('PASS: kit ZIP, extracted files, embedded copy-page listings and checksums match current sources.');
}
