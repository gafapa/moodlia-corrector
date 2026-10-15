import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';

const output = new URL('../extension/lib/', import.meta.url);
await mkdir(output, { recursive: true });
for (const [source, destination] of [
  ['pdfjs-dist/legacy/build/pdf.mjs', 'pdf.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
  ['pdfjs-dist/LICENSE', 'PDFJS-LICENSE'],
  ['fflate/esm/browser.js', 'fflate.mjs'],
  ['fflate/LICENSE', 'FFLATE-LICENSE'],
]) {
  await copyFile(new URL(`../node_modules/${source}`, import.meta.url), new URL(destination, output));
}
for (const directory of ['standard_fonts', 'cmaps', 'wasm']) {
  await cp(new URL(`../node_modules/pdfjs-dist/${directory}/`, import.meta.url), new URL(`${directory}/`, output), { recursive: true });
}
const pdfPackage = JSON.parse(await readFile(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url)));
console.log(`Bundled local attachment reader dependencies (PDF.js ${pdfPackage.version}).`);
