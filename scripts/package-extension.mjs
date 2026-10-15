import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

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
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json')));
const output = path.join(root, 'release', `moodlia-corrector-${manifest.version}.zip`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(`Packaged MoodlIA Corrector ${manifest.version}: ${output}`);
