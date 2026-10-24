import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';
import './validate-store-materials.mjs';
const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
const version = manifest.version;
const files = {};
const add = async (source, target) => { files[target] = new Uint8Array(await fs.readFile(source)); };
const extensionArchive = await fs.readFile(`release/moodlia-corrector-${version}.zip`);
for (const [name, bytes] of Object.entries(unzipSync(extensionArchive))) assert.deepEqual(Buffer.from(bytes), await fs.readFile(`extension/${name}`), `Stale extension archive: ${name}`);
files[`upload/moodlia-corrector-${version}.zip`] = new Uint8Array(extensionArchive);
let guide = await fs.readFile('marketplace/SUBMISSION.md', 'utf8');
for (const [source, target] of [
  [`release/moodlia-corrector-${version}.zip`, `upload/moodlia-corrector-${version}.zip`],
  ['marketplace/listings/', 'listings/'], ['extension/icons/icon-128.png', 'images/icon-128.png'],
  [`marketplace/assets/promo-small-${version}.png`, 'images/promo-small.png'],
  [`marketplace/assets/promo-marquee-${version}.png`, 'images/promo-marquee.png'],
  ['marketplace/screenshots/', 'images/'], ['marketplace/dashboard-fields.md', 'documents/dashboard-fields.md'],
  ['marketplace/privacy-policy.md', 'documents/privacy-policy.md'], ['marketplace/reviewer-instructions.md', 'documents/reviewer-instructions.md'],
]) guide = guide.replaceAll(source, target);
files['README.md'] = new TextEncoder().encode(guide);
for (const name of ['dashboard-fields.md', 'privacy-policy.md', 'privacy-policy.html', 'reviewer-instructions.md']) await add(`marketplace/${name}`, `documents/${name}`);
await add('CHANGELOG.md', 'documents/CHANGELOG.md');
const reports = (await fs.readdir('docs')).filter(name => name.startsWith('review-') && name.endsWith(`-${version}.json`)).sort();
assert.ok(reports.length, `Missing validation report for ${version}`);
await add(`docs/${reports.at(-1)}`, 'documents/validation.json');
await add('extension/icons/icon-128.png', 'images/icon-128.png');
for (const kind of ['small', 'marquee']) await add(`marketplace/assets/promo-${kind}-${version}.png`, `images/promo-${kind}.png`);
for (const name of await fs.readdir('marketplace/screenshots')) if (name.endsWith('.png')) await add(`marketplace/screenshots/${name}`, `images/${name}`);
for (const name of await fs.readdir('marketplace/listings')) if (name.endsWith('.json')) await add(`marketplace/listings/${name}`, `listings/${name}`);
for (const [name, bytes] of Object.entries(files)) {
  if (name.endsWith('.png')) {
    const buffer = Buffer.from(bytes);
    const size = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
    const expected = name.includes('icon-128') ? [128, 128] : name.includes('promo-small') ? [440, 280] : name.includes('promo-marquee') ? [1400, 560] : [1280, 800];
    assert.deepEqual(size, expected, name);
    if (!name.includes('icon-128')) assert.equal(buffer[25], 2, `${name} must be RGB PNG`);
  }
  if (name.startsWith('listings/')) {
    const listing = JSON.parse(Buffer.from(bytes).toString());
    assert.ok(listing.summary.length <= 132);
    assert.ok(listing.detailedDescription.length <= 16000);
  }
}
const checksums = Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([name, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n')+'\n';
files['SHA256SUMS.txt'] = new TextEncoder().encode(checksums);
const output = `release/moodlia-corrector-submission-kit-${version}.zip`;
const archive = zipSync(files, { level: 9 });
await fs.writeFile(output, archive);
for (const [name, bytes] of Object.entries(unzipSync(archive))) assert.deepEqual(Buffer.from(bytes), Buffer.from(files[name]), name);
console.log(JSON.stringify({ output: path.resolve(output), files: Object.keys(files).length, sha256: crypto.createHash('sha256').update(archive).digest('hex') }));
