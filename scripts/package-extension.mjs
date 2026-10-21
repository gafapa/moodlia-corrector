import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { expectedLibraryAssets, verifyExtensionAssets } from './extension-assets.mjs';
import { buildContentBundle } from './content-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'extension');
const files = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else files[path.relative(source, file).replaceAll(path.sep, '/')] = new Uint8Array(await readFile(file));
  }
}
await collect(source);
if (Buffer.from(files['src/content/moodleContent.js'] || []).toString().replaceAll('\r\n', '\n') !== await buildContentBundle(root)) {
  throw new Error('The Moodle content bundle is stale. Run npm run build before packaging.');
}
verifyExtensionAssets(files, await expectedLibraryAssets(path.join(root, 'node_modules')));
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json')));
const output = path.join(root, 'release', `moodlia-corrector-${manifest.version}.zip`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(`Packaged MoodlIA Corrector ${manifest.version}: ${output}`);
