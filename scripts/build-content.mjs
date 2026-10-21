import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildContentBundle } from './content-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await writeFile(path.join(root, 'extension/src/content/moodleContent.js'), await buildContentBundle(root));
console.log('Built the self-contained Moodle content entry point.');
