import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedLibraryAssets } from './extension-assets.mjs';

// extension/lib is generated: rebuild it from the exact asset list so files
// dropped from the bundle never linger in the package.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'extension/lib');
await rm(output, { recursive: true, force: true });
for (const [file, bytes] of Object.entries(await expectedLibraryAssets(path.join(root, 'node_modules')))) {
  const target = path.join(root, 'extension', file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const pdfPackage = JSON.parse(await readFile(path.join(root, 'node_modules/pdfjs-dist/package.json')));
console.log(`Bundled local attachment reader dependencies (PDF.js ${pdfPackage.version}).`);
