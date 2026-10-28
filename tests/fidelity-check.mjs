// Rendering-fidelity check: renders each corpus DOCX/ODT with the extension's
// local reader and compares every page with LibreOffice's PDF of the same file,
// rasterized by the same reader (pdf.js path). See docs/rendering-fidelity.md.
//
// Usage: node tests/fidelity-check.mjs [--only name,name] [--format odt|docx]
//        [--all-diffs] [--out <dir>]
// Exit code 1 when any file breaks its manifest expectations.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../', import.meta.url));
const corpus = join(repository, 'tests', 'fixtures', 'fidelity');
const extensionPath = join(repository, 'extension');
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const only = option('--only')?.split(',');
const formats = option('--format') ? [option('--format')] : ['odt', 'docx'];
const allDiffs = args.includes('--all-diffs');
const outputDir = option('--out') || join(repository, 'tests', 'fidelity', 'output');

if (!existsSync(join(extensionPath, 'lib', 'pdf.mjs'))) {
  console.error('The extension is not built: run `npm run build` first.');
  process.exit(2);
}
const manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'));
const METRICS = ['match', 'rows', 'columns', 'coverage', 'gutters'];

// ---------------------------------------------------------------------------
// Runs in the extension page. Page images are reduced to a grid of ~1.2 mm
// cells holding the mean "ink" (darkness) of the cell, measured on the
// full-resolution pixels, so both renderers are compared at the same scale.
function installFidelityHelpers({ gridWidth, inkThreshold, profileRadius, matchRadius, gutterBand, gutterMin, gutterFloor }) {
  const decode = async ({ mimeType, base64Data }) => {
    const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(base64Data) : Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    return createImageBitmap(new Blob([bytes], { type: mimeType }));
  };
  // Grid with a fixed number of columns; rows follow the image's own aspect ratio.
  const toGrid = (bitmap, columns) => {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    const rows = Math.max(1, Math.round(height * columns / width));
    const sum = new Float64Array(columns * rows);
    const count = new Float64Array(columns * rows);
    for (let y = 0; y < height; y++) {
      const gy = Math.min(rows - 1, Math.floor(y * rows / height));
      for (let x = 0; x < width; x++) {
        const gx = Math.min(columns - 1, Math.floor(x * columns / width));
        const offset = (y * width + x) * 4;
        const luminance = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
        sum[gy * columns + gx] += 1 - luminance;
        count[gy * columns + gx]++;
      }
    }
    for (let index = 0; index < sum.length; index++) sum[index] /= count[index] || 1;
    return { columns, rows, ink: sum, aspect: height / width };
  };
  // Pads a grid with white rows so two grids share a height.
  const padRows = (grid, rows) => {
    if (grid.rows >= rows) return grid;
    const ink = new Float64Array(grid.columns * rows);
    ink.set(grid.ink);
    return { ...grid, rows, ink };
  };
  const smooth = (values, radius) => values.map((_, index) => {
    let total = 0;
    let n = 0;
    for (let k = Math.max(0, index - radius); k <= Math.min(values.length - 1, index + radius); k++) { total += values[k]; n++; }
    return total / n;
  });
  const correlation = (a, b) => {
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    const ma = mean(a);
    const mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    if (da < 1e-9 && db < 1e-9) return 1;
    if (da < 1e-9 || db < 1e-9) return 0;
    return num / Math.sqrt(da * db);
  };
  const mask = (grid) => Uint8Array.from(grid.ink, (value) => value > inkThreshold ? 1 : 0);
  const dilate = (bits, columns, rows, radius) => {
    // Separable square dilation.
    const horizontal = new Uint8Array(bits.length);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        let on = 0;
        for (let k = Math.max(0, x - radius); k <= Math.min(columns - 1, x + radius) && !on; k++) on = bits[y * columns + k];
        horizontal[y * columns + x] = on;
      }
    }
    const result = new Uint8Array(bits.length);
    for (let x = 0; x < columns; x++) {
      for (let y = 0; y < rows; y++) {
        let on = 0;
        for (let k = Math.max(0, y - radius); k <= Math.min(rows - 1, y + radius) && !on; k++) on = horizontal[k * columns + x];
        result[y * columns + x] = on;
      }
    }
    return result;
  };
  const comparePage = (referenceGrid, renderedGrid) => {
    const rows = Math.max(referenceGrid.rows, renderedGrid.rows);
    const a = padRows(referenceGrid, rows);
    const b = padRows(renderedGrid, rows);
    const { columns } = a;
    const rowProfile = (g) => Array.from({ length: rows }, (_, y) => g.ink.subarray(y * columns, (y + 1) * columns).reduce((s, x) => s + x, 0));
    const columnProfile = (g) => Array.from({ length: columns }, (_, x) => { let s = 0; for (let y = 0; y < rows; y++) s += g.ink[y * columns + x]; return s; });
    const inkA = a.ink.reduce((s, x) => s + x, 0);
    const inkB = b.ink.reduce((s, x) => s + x, 0);
    const maskA = mask(a);
    const maskB = mask(b);
    const nearA = dilate(maskA, columns, rows, matchRadius);
    const nearB = dilate(maskB, columns, rows, matchRadius);
    let countA = 0, countB = 0, hitA = 0, hitB = 0;
    for (let i = 0; i < maskA.length; i++) {
      if (maskA[i]) { countA++; if (nearB[i]) hitA++; }
      if (maskB[i]) { countB++; if (nearA[i]) hitB++; }
    }
    // Wide low-ink gaps that run down several lines are layout structure (columns,
    // text beside a picture, table cells, tab stops), not word spacing. A gutter
    // profile counts, per grid column, the windows where such a gap crosses it; a
    // page whose columns or wrapping are lost keeps similar ink but a different profile.
    const gutterProfile = (g) => {
      const profile = new Float64Array(columns);
      // Tall windows (several text lines) make column sums independent of where
      // lines, descenders or rules fall; windows overlap by half their height.
      for (let top = 0; top < rows; top += Math.max(1, gutterBand >> 1)) {
        const sums = new Float64Array(columns);
        for (let y = top; y < Math.min(rows, top + gutterBand); y++) for (let x = 0; x < columns; x++) sums[x] += g.ink[y * columns + x];
        const inked = [...sums].filter((value) => value > inkThreshold).sort((p, q) => p - q);
        if (inked.length < 2 * gutterMin) continue;
        const floor = 0.1 * inked[inked.length >> 1];
        let first = 0;
        while (first < columns && sums[first] <= floor) first++;
        let last = columns - 1;
        while (last > first && sums[last] <= floor) last--;
        for (let x = first + 1, start = -1; x <= last; x++) {
          if (sums[x] <= floor && start < 0) start = x;
          if (sums[x] > floor && start >= 0) {
            if (x - start >= gutterMin) for (let k = start; k < x; k++) profile[k]++;
            start = -1;
          }
        }
      }
      return smooth([...profile], 2);
    };
    const gutterA = gutterProfile(a);
    const gutterB = gutterProfile(b);
    const gutterTotal = gutterA.reduce((s, x) => s + x, 0) + gutterB.reduce((s, x) => s + x, 0);
    const gutterDifference = gutterA.reduce((s, x, i) => s + Math.abs(x - gutterB[i]), 0);
    // The difference is scaled by at least gutterFloor band-cells, so a few stray gaps
    // (a tab, a short heading number) on a page without real gap structure stay minor.
    const gutters = 1 - gutterDifference / Math.max(gutterTotal, gutterFloor);
    // Share of reference ink with rendered ink nearby (missing content lowers it) and
    // share of rendered ink with reference ink nearby (extra or misplaced content lowers it).
    const recall = countA ? hitA / countA : (countB ? 0 : 1);
    const precision = countB ? hitB / countB : (countA ? 0 : 1);
    return {
      match: recall + precision ? 2 * recall * precision / (recall + precision) : 0,
      gutters, gutterSums: [Math.round(gutterA.reduce((s, x) => s + x, 0)), Math.round(gutterB.reduce((s, x) => s + x, 0))],
      recall, precision,
      rows: correlation(smooth(rowProfile(a), profileRadius), smooth(rowProfile(b), profileRadius)),
      columns: correlation(smooth(columnProfile(a), profileRadius), smooth(columnProfile(b), profileRadius)),
      coverage: Math.max(inkA, inkB) > 1e-6 ? Math.min(inkA, inkB) / Math.max(inkA, inkB) : 1,
      aspect: Math.min(referenceGrid.aspect, renderedGrid.aspect) / Math.max(referenceGrid.aspect, renderedGrid.aspect),
    };
  };
  const pages = new Map();
  globalThis.fidelity = {
    async read(key, file) {
      const { readAttachment } = await import(chrome.runtime.getURL('src/attachments/reader.js'));
      const started = performance.now();
      const attachment = await readAttachment(file);
      const images = (attachment.images || []).filter((image) => image.pageNumber);
      pages.set(key, images);
      return { pageCount: attachment.pageCount, imagePages: images.map((image) => image.pageNumber), limitations: attachment.imageLimitations || [], milliseconds: Math.round(performance.now() - started) };
    },
    async compare(referenceKey, renderedKey) {
      const reference = pages.get(referenceKey);
      const rendered = pages.get(renderedKey);
      const results = [];
      for (let index = 0; index < Math.min(reference.length, rendered.length); index++) {
        const [refBitmap, ownBitmap] = await Promise.all([decode(reference[index]), decode(rendered[index])]);
        const refGrid = toGrid(refBitmap, refBitmap.width > refBitmap.height ? Math.round(gridWidth * Math.SQRT2) : gridWidth);
        const ownGrid = toGrid(ownBitmap, refGrid.columns);
        results.push({ page: index + 1, reference: [refBitmap.width, refBitmap.height], rendered: [ownBitmap.width, ownBitmap.height], ...comparePage(refGrid, ownGrid) });
        refBitmap.close(); ownBitmap.close();
      }
      return results;
    },
    // Reference | rendered | overlay (reference ink red, rendered ink blue, shared ink black).
    async diff(referenceKey, renderedKey, index) {
      const reference = pages.get(referenceKey)[index];
      const rendered = pages.get(renderedKey)[index];
      const bitmaps = await Promise.all([reference, rendered].filter(Boolean).map(decode));
      const width = 700;
      const scaled = bitmaps.map((bitmap) => ({ bitmap, height: Math.round(bitmap.height * width / bitmap.width) }));
      const height = Math.max(...scaled.map((entry) => entry.height));
      const gap = 12;
      const canvas = new OffscreenCanvas(width * 3 + gap * 2, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#888';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const layers = [];
      scaled.forEach(({ bitmap, height: h }, slot) => {
        context.fillStyle = '#fff';
        context.fillRect(slot * (width + gap), 0, width, h);
        context.drawImage(bitmap, slot * (width + gap), 0, width, h);
        layers.push(context.getImageData(slot * (width + gap), 0, width, height));
      });
      const overlay = context.createImageData(width, height);
      for (let i = 0; i < overlay.data.length; i += 4) {
        const dark = (layer) => layer ? 1 - (layer.data[i] * 0.2126 + layer.data[i + 1] * 0.7152 + layer.data[i + 2] * 0.0722) / 255 > 0.25 : false;
        const a = dark(layers[0]);
        const b = dark(layers[1]);
        const [r, g, bl] = a && b ? [0, 0, 0] : a ? [220, 30, 30] : b ? [30, 90, 230] : [255, 255, 255];
        overlay.data.set([r, g, bl, 255], i);
      }
      context.putImageData(overlay, (width + gap) * 2, 0);
      bitmaps.forEach((bitmap) => bitmap.close());
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    release(key) { pages.delete(key); },
  };
}

// ---------------------------------------------------------------------------
const started = Date.now();
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
context.setDefaultTimeout(180000);
const report = { generatedAt: new Date().toISOString(), reference: manifest.reference, settings: manifest.settings, files: [] };
let failures = 0;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`Page error: ${error.message}`));
  await page.goto(`chrome-extension://${extensionId}/src/attachments/reader.html`);
  await page.evaluate(installFidelityHelpers, manifest.settings);
  await mkdir(outputDir, { recursive: true });

  const names = Object.keys(manifest.documents).filter((name) => !only || only.includes(name));
  for (const name of names) {
    for (const format of formats) {
      // Per-file values override the defaults metric by metric.
      const spec = manifest.documents[name][format] || {};
      const expected = { ...manifest.defaults, ...spec, min: { ...manifest.defaults.min, ...spec.min } };
      delete expected.observed;
      const mime = format === 'odt' ? 'application/vnd.oasis.opendocument.text' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const entry = { file: `${name}.${format}`, expected, problems: [] };
      try {
        const [ownBytes, refBytes] = await Promise.all([readFile(join(corpus, `${name}.${format}`)), readFile(join(corpus, 'reference', `${name}.${format}.pdf`))]);
        const own = await page.evaluate(([key, file]) => globalThis.fidelity.read(key, file), ['own', { name: `${name}.${format}`, mimeType: mime, base64Data: ownBytes.toString('base64') }]);
        const ref = await page.evaluate(([key, file]) => globalThis.fidelity.read(key, file), ['ref', { name: `${name}.${format}.pdf`, mimeType: 'application/pdf', base64Data: refBytes.toString('base64') }]);
        Object.assign(entry, { renderedPages: own.pageCount, referencePages: ref.pageCount, renderMs: own.milliseconds, limitations: own.limitations });
        if (own.imagePages.length !== own.pageCount) entry.problems.push(`only ${own.imagePages.length} of ${own.pageCount} pages were rasterized`);
        const pageDelta = Math.abs(own.pageCount - ref.pageCount);
        if (pageDelta > (expected.pageTolerance || 0)) entry.problems.push(`page count ${own.pageCount} != reference ${ref.pageCount}`);
        if (expected.pages !== undefined && ref.pageCount !== expected.pages) entry.problems.push(`reference has ${ref.pageCount} pages, manifest expects ${expected.pages} (regenerated corpus?)`);
        entry.pages = await page.evaluate(() => globalThis.fidelity.compare('ref', 'own'));
        entry.min = Object.fromEntries([...METRICS, 'aspect'].map((metric) => [metric, entry.pages.length ? Math.min(...entry.pages.map((p) => p[metric])) : 0]));
        const failingPages = new Set();
        for (const result of entry.pages) {
          for (const metric of METRICS) {
            if (result[metric] < expected.min[metric]) { failingPages.add(result.page); entry.problems.push(`page ${result.page}: ${metric} ${result[metric].toFixed(3)} < ${expected.min[metric]}`); }
          }
          if (result.aspect < expected.min.aspect) { failingPages.add(result.page); entry.problems.push(`page ${result.page}: page shape differs (aspect ${result.aspect.toFixed(3)})`); }
        }
        // Pages present on one side only are drawn against an empty slot.
        for (let index = Math.min(own.pageCount, ref.pageCount); index < Math.max(own.pageCount, ref.pageCount); index++) failingPages.add(index + 1);
        // A known difference that now meets the defaults should leave the manifest.
        const meetsDefaults = pageDelta === 0 && [...METRICS, 'aspect'].every((metric) => entry.min[metric] >= manifest.defaults.min[metric]);
        if (expected.knownDifference && meetsDefaults) entry.note = 'meets the default thresholds now: remove its known difference from the manifest';
        const diffPages = allDiffs ? Array.from({ length: Math.max(own.pageCount, ref.pageCount) }, (_, i) => i + 1) : entry.problems.length ? [...failingPages] : [];
        entry.diffs = [];
        for (const pageNumber of diffPages.sort((a, b) => a - b)) {
          const png = await page.evaluate(([index]) => globalThis.fidelity.diff('ref', 'own', index), [pageNumber - 1]);
          const path = join(outputDir, `${name}.${format}.p${pageNumber}.png`);
          await writeFile(path, Buffer.from(png, 'base64'));
          entry.diffs.push(path);
        }
      } catch (error) {
        entry.problems.push(`error: ${error.message}`);
      }
      entry.status = entry.problems.length ? 'FAIL' : expected.knownDifference ? 'KNOWN' : 'PASS';
      if (entry.problems.length) failures++;
      report.files.push(entry);
      const fmt = (value) => value === undefined ? '  -  ' : value.toFixed(3);
      console.log(`${entry.status.padEnd(5)} ${entry.file.padEnd(24)} pages ${String(entry.renderedPages ?? '?').padStart(2)}/${String(entry.referencePages ?? '?').padEnd(2)} match ${fmt(entry.min?.match)} rows ${fmt(entry.min?.rows)} cols ${fmt(entry.min?.columns)} cover ${fmt(entry.min?.coverage)} gutters ${fmt(entry.min?.gutters)} ${entry.renderMs ?? '?'} ms`);
      for (const problem of entry.problems) console.log(`      - ${problem}`);
      if (entry.note) console.log(`      * ${entry.note}`);
    }
  }
} finally {
  await context.close();
}
report.seconds = Math.round((Date.now() - started) / 100) / 10;
report.failures = failures;
await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('');
console.table(report.files.map((entry) => ({
  file: entry.file, status: entry.status, pages: `${entry.renderedPages ?? '?'}/${entry.referencePages ?? '?'}`,
  ...Object.fromEntries(METRICS.map((metric) => [metric, entry.min ? Number(entry.min[metric].toFixed(3)) : null])),
})));
console.log(`${report.files.length} renderings compared in ${report.seconds} s; ${failures} failing. Report: ${join(outputDir, 'report.json')}`);
process.exitCode = failures ? 1 : 0;
