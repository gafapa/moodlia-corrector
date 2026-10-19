import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function expectedLibraryAssets(dependencyRoot) {
  const assets = {};
  for (const [source, target] of [
    ['pdfjs-dist/legacy/build/pdf.mjs', 'pdf.mjs'],
    ['pdfjs-dist/legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
    ['pdfjs-dist/LICENSE', 'PDFJS-LICENSE'],
    ['fflate/esm/browser.js', 'fflate.mjs'],
    ['fflate/LICENSE', 'FFLATE-LICENSE'],
  ]) assets[`lib/${target}`] = await readFile(path.join(dependencyRoot, source));
  async function collect(directory, relative) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (!entries.length) throw new Error(`Empty dependency directory: ${relative}`);
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const target = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(source, target);
      else assets[target] = await readFile(source);
    }
  }
  for (const directory of ['standard_fonts', 'cmaps', 'wasm']) await collect(path.join(dependencyRoot, 'pdfjs-dist', directory), `lib/${directory}`);
  return assets;
}

export function verifyExtensionAssets(files, expectedLibraries) {
  const manifest = JSON.parse(Buffer.from(files['manifest.json'] || []).toString());
  const referenced = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry) => entry.js || [])];
  for (const file of referenced) if (!files[file]?.length) throw new Error(`Missing or empty extension asset: ${file}`);
  if (manifest.default_locale) {
    for (const file of ['src/i18n.js', 'src/i18nMessages.js', `_locales/${manifest.default_locale}/messages.json`]) {
      if (!files[file]?.length) throw new Error(`Missing localization asset: ${file}`);
    }
    const baseline = JSON.parse(Buffer.from(files[`_locales/${manifest.default_locale}/messages.json`]).toString());
    for (const [file, bytes] of Object.entries(files).filter(([file]) => /^_locales\/[^/]+\/messages\.json$/.test(file))) {
      const catalog = JSON.parse(Buffer.from(bytes).toString());
      for (const key of Object.keys(baseline)) if (!catalog[key]?.message?.trim()) throw new Error(`Missing translation: ${file} ${key}`);
    }
  }
  for (const [file, expected] of Object.entries(expectedLibraries)) {
    if (!files[file]?.length) throw new Error(`Missing or empty bundled library asset: ${file}`);
    if (!Buffer.from(files[file]).equals(Buffer.from(expected))) throw new Error(`Bundled library differs from installed dependency: ${file}`);
  }
  for (const [file, bytes] of Object.entries(files)) {
    if (/\.(?:js|mjs|json|html|css|md)$/.test(file)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`Extension text asset must use UTF-8: ${file}`); }
    }
  }
}
