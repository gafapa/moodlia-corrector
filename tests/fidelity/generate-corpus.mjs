// Generates the rendering-fidelity corpus: fictional documents written as Flat
// ODT (.fodt) sources, converted by LibreOffice (headless) into ODT and DOCX,
// and each ODT/DOCX printed to a reference PDF by LibreOffice.
//
// Usage: node tests/fidelity/generate-corpus.mjs [--soffice <path>] [--only name,name]
//
// The outputs are kept in the tree so `npm run test:fidelity` runs without
// LibreOffice. Re-running this script re-creates them (LibreOffice embeds dates
// and generator metadata, so binaries change byte-wise on every run).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('../fixtures/fidelity/', import.meta.url));
const sourceDir = join(root, 'source');
const referenceDir = join(root, 'reference');

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const soffice = option('--soffice') || process.env.SOFFICE || [
  'C:/Program Files/LibreOffice/program/soffice.com',
  'C:/Program Files (x86)/LibreOffice/program/soffice.com',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice',
].find((candidate) => existsSync(candidate));
const only = option('--only')?.split(',');

// ---------------------------------------------------------------------------
// Deterministic fictional text.
let seed = 0;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const SUBJECTS = ['The survey team', 'The Brindlemoor committee', 'Each volunteer', 'The harbour office', 'The fictional cooperative', 'A small working group', 'The night shift', 'The archive keeper', 'Every visiting student', 'The lighthouse crew'];
const VERBS = ['recorded', 'compared', 'described', 'measured', 'reviewed', 'catalogued', 'summarised', 'questioned', 'estimated', 'mapped'];
const OBJECTS = ['the tidal patterns of the northern bay', 'the growth of moss on the old stone walls', 'the number of lanterns repaired each winter', 'the amount of rain collected in copper gauges', 'the routes taken by the ferry during storms', 'the colours of the evening sky over the dunes', 'the condition of the wooden pier', 'the songs sung at the autumn market', 'the weight of the fishing nets after each trip', 'the height of the hedges along the canal'];
const TAILS = ['before the season ended', 'with remarkable patience', 'using only paper notebooks', 'over three consecutive weeks', 'despite the persistent fog', 'for the annual report', 'while the tide was low', 'in a careful and orderly way', 'according to the old manual', 'without any modern instruments'];
const sentence = () => `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}.`;
const paragraph = (count = 5) => Array.from({ length: count }, sentence).join(' ');
const words = (count) => paragraph(3).split(' ').slice(0, count).join(' ').replace(/[.,]$/, '');

// ---------------------------------------------------------------------------
// Tiny images: PNGs drawn here and a JPEG encoded by Chromium.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const makePng = (width, height, paint) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(paint(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
};
// A bar chart: dark frame, three coloured bars, white background.
const CHART_PNG = makePng(60, 40, (x, y) => {
  if (x === 0 || y === 39 || x === 59 || y === 0) return [0, 0, 0];
  const bars = [[8, 18, 12, [44, 94, 143]], [24, 34, 22, [192, 57, 43]], [40, 50, 6, [30, 125, 50]]];
  for (const [from, to, top, colour] of bars) if (x >= from && x < to && y >= top && y < 38) return colour;
  return [255, 255, 255];
}).toString('base64');
// A diagonal stripe badge.
const BADGE_PNG = makePng(32, 32, (x, y) => {
  const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 15 ** 2;
  if (!inside) return [255, 255, 255];
  return (x + y) % 8 < 4 ? [20, 40, 90] : [240, 200, 60];
}).toString('base64');
// A small landscape picture encoded as JPEG by Playwright's Chromium (a dev dependency),
// so the corpus also covers a lossy format without storing a hand-made blob here.
const makeJpeg = async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 48; canvas.height = 32;
      const c = canvas.getContext('2d');
      c.fillStyle = '#f2e6c8'; c.fillRect(0, 0, 48, 32);
      c.fillStyle = '#2a5d8f'; c.fillRect(0, 20, 48, 12);
      c.fillStyle = '#c0392b'; c.beginPath(); c.arc(34, 10, 6, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1e7d32'; c.beginPath(); c.moveTo(2, 20); c.lineTo(14, 6); c.lineTo(26, 20); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 2; c.strokeRect(1, 1, 46, 30);
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    });
  } finally {
    await browser.close();
  }
};
const LANDSCAPE_JPEG = await makeJpeg();

// ---------------------------------------------------------------------------
// Flat ODT building blocks.
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const p = (style, content) => `<text:p text:style-name="${style}">${content}</text:p>`;
const body = (text) => p('Text_20_body', escape(text));
const h = (level, text) => `<text:h text:style-name="Heading_20_${level}" text:outline-level="${level}">${escape(text)}</text:h>`;
const span = (style, text) => `<text:span text:style-name="${style}">${escape(text)}</text:span>`;
const image = ({ name, data, width, height, anchor = 'as-char', style = 'frImage', x, y }) =>
  `<draw:frame draw:style-name="${style}" draw:name="${name}" text:anchor-type="${anchor}"${x ? ` svg:x="${x}"` : ''}${y ? ` svg:y="${y}"` : ''} svg:width="${width}" svg:height="${height}" draw:z-index="0"><draw:image><office:binary-data>${data}</office:binary-data></draw:image></draw:frame>`;

const pageLayout = (name, { width = '21cm', height = '29.7cm', orientation = 'portrait', margin = '2cm', marginTop, marginBottom, header = false, footer = false, columns = '' } = {}) => `
  <style:page-layout style:name="${name}">
    <style:page-layout-properties fo:page-width="${width}" fo:page-height="${height}" style:print-orientation="${orientation}" fo:margin-top="${marginTop || margin}" fo:margin-bottom="${marginBottom || margin}" fo:margin-left="${margin}" fo:margin-right="${margin}" style:writing-mode="lr-tb">${columns}</style:page-layout-properties>
    <style:header-style>${header ? '<style:header-footer-properties fo:min-height="0cm" fo:margin-bottom="0.5cm"/>' : ''}</style:header-style>
    <style:footer-style>${footer ? '<style:header-footer-properties fo:min-height="0cm" fo:margin-top="0.5cm"/>' : ''}</style:footer-style>
  </style:page-layout>`;

const outlineLevels = (numbered) => Array.from({ length: 10 }, (_, index) => {
  const level = index + 1;
  return `<text:outline-level-style text:level="${level}" style:num-format="${numbered && level <= 3 ? '1' : ''}"${numbered && level <= 3 ? ` style:num-suffix="${level === 1 ? '.' : ''}" text:display-levels="${level}"` : ''}><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${(0.762 + 0.254 * index).toFixed(3)}cm" fo:text-indent="-${(0.762 + 0.254 * index).toFixed(3)}cm" fo:margin-left="${(0.762 + 0.254 * index).toFixed(3)}cm"/></style:list-level-properties></text:outline-level-style>`;
}).join('');

const COMMON_STYLES = `
  <style:default-style style:family="graphic"><style:graphic-properties svg:stroke-color="#3465a4" draw:fill-color="#729fcf"/></style:default-style>
  <style:default-style style:family="paragraph">
    <style:paragraph-properties fo:hyphenation-ladder-count="no-limit" style:writing-mode="page" style:tab-stop-distance="1.251cm"/>
    <style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="en" fo:country="GB" fo:hyphenate="false"/>
  </style:default-style>
  <style:default-style style:family="table"><style:table-properties table:border-model="collapsing"/></style:default-style>
  <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
  <style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
    <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.247cm" fo:line-height="115%" fo:text-align="justify"/>
  </style:style>
  <style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text">
    <style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm" fo:keep-with-next="always"/>
    <style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'" fo:font-size="14pt"/>
  </style:style>
  <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="1" style:class="text">
    <style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm"/>
    <style:text-properties fo:font-size="18pt" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2" style:class="text">
    <style:paragraph-properties fo:margin-top="0.353cm" fo:margin-bottom="0.212cm"/>
    <style:text-properties fo:font-size="16pt" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="3" style:class="text">
    <style:paragraph-properties fo:margin-top="0.247cm" fo:margin-bottom="0.212cm"/>
    <style:text-properties fo:font-size="14pt" fo:font-weight="bold" fo:color="#333333"/>
  </style:style>
  <style:style style:name="Title" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:class="chapter">
    <style:paragraph-properties fo:text-align="center"/>
    <style:text-properties fo:font-size="26pt" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="List_20_Paragraph" style:display-name="List Paragraph" style:family="paragraph" style:parent-style-name="Text_20_body" style:class="list">
    <style:paragraph-properties fo:margin-bottom="0.1cm" fo:text-align="start"/>
  </style:style>
  <style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:paragraph-properties fo:margin-top="0.05cm" fo:margin-bottom="0.05cm" fo:margin-left="0.1cm" fo:margin-right="0.1cm"/>
    <style:text-properties fo:font-size="11pt"/>
  </style:style>
  <style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra">
    <style:paragraph-properties fo:text-align="center"/>
    <style:text-properties fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:paragraph-properties><style:tab-stops><style:tab-stop style:position="8.5cm" style:type="center"/><style:tab-stop style:position="17cm" style:type="right"/></style:tab-stops></style:paragraph-properties>
    <style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'" fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Header" style:class="extra"/>
  <style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:paragraph-properties fo:margin-left="0.6cm" fo:text-indent="-0.6cm"/>
    <style:text-properties fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="Endnote" style:family="paragraph" style:parent-style-name="Footnote" style:class="extra"/>
  <style:style style:name="Caption" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:paragraph-properties fo:margin-top="0.1cm" fo:margin-bottom="0.3cm" fo:text-align="center"/>
    <style:text-properties fo:font-size="10pt" fo:font-style="italic"/>
  </style:style>
  <style:style style:name="Frame_20_contents" style:display-name="Frame contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'" fo:font-size="10pt"/>
  </style:style>
  <style:style style:name="Footnote_20_Symbol" style:display-name="Footnote Symbol" style:family="text"/>
  <style:style style:name="Footnote_20_anchor" style:display-name="Footnote anchor" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
  <style:style style:name="Endnote_20_Symbol" style:display-name="Endnote Symbol" style:family="text"/>
  <style:style style:name="Endnote_20_anchor" style:display-name="Endnote anchor" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
  <text:notes-configuration text:note-class="footnote" text:citation-style-name="Footnote_20_Symbol" text:citation-body-style-name="Footnote_20_anchor" style:num-format="1" text:start-value="0" text:footnotes-position="page" text:start-numbering-at="document"/>
  <text:notes-configuration text:note-class="endnote" text:citation-style-name="Endnote_20_Symbol" text:citation-body-style-name="Endnote_20_anchor" style:num-format="i" text:start-value="0"/>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>`;

const fonts = `
  <office:font-face-decls>
    <style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" style:font-family-generic="roman" style:font-pitch="variable"/>
    <style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss" style:font-pitch="variable"/>
    <style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-family-generic="modern" style:font-pitch="fixed"/>
  </office:font-face-decls>`;

const fodt = ({ title, styles = '', numberedHeadings = false, automatic = '', layouts = pageLayout('pm1'), masters = '<style:master-page style:name="Standard" style:page-layout-name="pm1"/>', content }) => `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:math="http://www.w3.org/1998/Math/MathML" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
  <office:meta><dc:title>${escape(title)}</dc:title><meta:initial-creator>MoodlIA fidelity corpus (fictional)</meta:initial-creator></office:meta>${fonts}
  <office:styles>${COMMON_STYLES}${styles}
    <text:outline-style style:name="Outline">${outlineLevels(numberedHeadings)}</text:outline-style>
  </office:styles>
  <office:automatic-styles>${layouts}${automatic}</office:automatic-styles>
  <office:master-styles>${masters}</office:master-styles>
  <office:body><office:text>${content}</office:text></office:body>
</office:document>
`;

// List styles: numbered (1. / a) / i.) and bulleted (bullet / en dash / square).
const listLevel = (kind, level, format) => {
  const indent = (0.635 * level).toFixed(3);
  const position = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${indent}cm" fo:text-indent="-0.635cm" fo:margin-left="${indent}cm"/></style:list-level-properties>`;
  if (kind === 'bullet') return `<text:list-level-style-bullet text:level="${level}" text:bullet-char="${format}">${position}<style:text-properties style:font-name="Liberation Serif"/></text:list-level-style-bullet>`;
  const [num, suffix] = format;
  return `<text:list-level-style-number text:level="${level}" style:num-format="${num}" style:num-suffix="${suffix}">${position}</text:list-level-style-number>`;
};
const NUMBERED_LIST = `<text:list-style style:name="Numbered">${[['1', '.'], ['a', ')'], ['i', '.']].map((format, index) => listLevel('number', index + 1, format)).join('')}</text:list-style>`;
const BULLET_LIST = `<text:list-style style:name="Bullets">${['\u2022', '\u2013', '\u25aa'].map((format, index) => listLevel('bullet', index + 1, format)).join('')}</text:list-style>`;
const item = (text, children = '', extra = '') => `<text:list-item${extra}>${p('List_20_Paragraph', escape(text))}${children}</text:list-item>`;
const list = (style, items, attributes = '') => `<text:list text:style-name="${style}"${attributes}>${items.join('')}</text:list>`;

const cell = (text, { style = 'TCell', paragraph = 'Table_20_Contents', colspan, rowspan } = {}) =>
  `<table:table-cell table:style-name="${style}" office:value-type="string"${colspan ? ` table:number-columns-spanned="${colspan}"` : ''}${rowspan ? ` table:number-rows-spanned="${rowspan}"` : ''}>${p(paragraph, escape(text))}</table:table-cell>`;
const covered = '<table:covered-table-cell/>';
const row = (cells) => `<table:table-row>${cells.join('')}</table:table-row>`;
const TABLE_STYLES = `
  <style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="margins" fo:margin-top="0.2cm" fo:margin-bottom="0.3cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="0.5pt solid #000000"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="#1f3b5c" fo:padding="0.08cm" fo:border="1.5pt solid #000000"/></style:style>
  <style:style style:name="TShade" style:family="table-cell"><style:table-cell-properties fo:background-color="#dce6f2" fo:padding="0.08cm" fo:border="0.5pt solid #000000"/></style:style>
  <style:style style:name="TWarm" style:family="table-cell"><style:table-cell-properties fo:background-color="#f6dfb4" fo:padding="0.08cm" fo:border="0.5pt solid #000000"/></style:style>
  <style:style style:name="TRule" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border-left="none" fo:border-right="none" fo:border-top="none" fo:border-bottom="0.75pt solid #555555"/></style:style>
  <style:style style:name="THeadText" style:family="paragraph" style:parent-style-name="Table_20_Heading"><style:text-properties fo:color="#ffffff"/></style:style>`;
const columns = (name, widths) => widths.map((width, index) => `<table:table-column table:style-name="${name}.${index}"/>`).join('');
const columnStyles = (name, widths) => widths.map((width, index) => `<style:style style:name="${name}.${index}" style:family="table-column"><style:table-column-properties style:column-width="${width}"/></style:style>`).join('');

// ---------------------------------------------------------------------------
// The corpus. Every document is fictional; names and figures are invented.
const documents = {};

documents['prose-multipage'] = () => {
  seed = 11;
  return fodt({
    title: 'Notes on the Brindlemoor Coast',
    content: [p('Title', 'Notes on the Brindlemoor Coast'), p('Standard', ''),
      ...Array.from({ length: 16 }, () => body(paragraph(7)))].join(''),
  });
};

documents['headings-outline'] = () => {
  seed = 22;
  const parts = [p('Title', 'Field Manual for the Harbour Survey')];
  for (let chapter = 1; chapter <= 3; chapter++) {
    parts.push(h(1, `${pick(['Preparation', 'Observation', 'Reporting', 'Equipment'])} of the survey`), body(paragraph(4)));
    for (let section = 1; section <= 2; section++) {
      parts.push(h(2, `${pick(['Tides', 'Lanterns', 'Weather', 'Boats', 'Records'])} and ${pick(['schedules', 'notebooks', 'volunteers', 'routes'])}`), body(paragraph(3)));
      if (section === 2) parts.push(h(3, 'Detailed procedure'), body(paragraph(3)), h(3, 'Common mistakes'), body(paragraph(2)));
    }
  }
  return fodt({ title: 'Field Manual', numberedHeadings: true, content: parts.join('') });
};

documents['lists-nested'] = () => {
  seed = 33;
  const short = () => words(6 + Math.floor(random() * 8));
  const content = [
    p('Title', 'Checklist for the Lantern Workshop'),
    h(1, 'Numbered steps with nested levels'),
    list('Numbered', [
      item(short()),
      item(short(), list('Numbered', [item(short()), item(short(), list('Numbered', [item(short()), item(short())])), item(short())])),
      item(short()),
    ], ' xml:id="list-main"'),
    body('The numbering continues after this paragraph, because the second part of the checklist belongs to the same sequence of steps.'),
    list('Numbered', [item(short()), item(short())], ' text:continue-list="list-main"'),
    h(1, 'A new list that restarts'),
    list('Numbered', [item(short()), item(short()), item(short())]),
    body('The next list starts at five on purpose.'),
    list('Numbered', [item(short(), '', ' text:start-value="5"'), item(short())]),
    h(1, 'Bulleted materials'),
    list('Bullets', [
      item(short()),
      item(short(), list('Bullets', [item(short()), item(short(), list('Bullets', [item(short()), item(short())]))])),
      item(short()),
      item(words(40)),
    ]),
    body(paragraph(3)),
  ].join('');
  return fodt({ title: 'Lists', styles: NUMBERED_LIST + BULLET_LIST, content });
};

documents['tables-styled'] = () => {
  seed = 44;
  const widths = ['4.25cm', '4.25cm', '4.25cm', '4.25cm'];
  const head = (text) => cell(text, { style: 'THead', paragraph: 'THeadText' });
  const table = `<table:table table:name="Inventory" table:style-name="Tbl">${columns('Inv', widths)}
    <table:table-header-rows>${row([head('Item'), head('Quarter 1'), head('Quarter 2'), head('Notes')])}</table:table-header-rows>
    ${row([cell('Copper gauges'), cell('12', { style: 'TShade' }), cell('15', { style: 'TShade' }), cell('Two need new seals.', { rowspan: 2 })])}
    ${row([cell('Lantern glass'), cell('40 panes in total over both quarters', { colspan: 2, style: 'TWarm' }), covered, covered])}
    ${row([cell('Rope (metres)'), cell('320'), cell('290'), cell('Stored in shed B.')])}
    ${row([cell('Totals', { style: 'TShade', paragraph: 'Table_20_Heading' }), cell('All items counted twice by the fictional team.', { colspan: 3, style: 'TShade' }), covered, covered])}
  </table:table>`;
  const ruled = `<table:table table:name="Ruled" table:style-name="Tbl">${columns('Rul', ['5cm', '6cm', '6cm'])}
    ${row([cell('Station', { style: 'TRule', paragraph: 'Table_20_Heading' }), cell('Morning reading', { style: 'TRule', paragraph: 'Table_20_Heading' }), cell('Evening reading', { style: 'TRule', paragraph: 'Table_20_Heading' })])}
    ${['North pier', 'Old mill', 'Dune path', 'Signal hill'].map((name, index) => row([cell(name, { style: 'TRule' }), cell(`${12 + index * 3} mm`, { style: 'TRule' }), cell(`${9 + index * 2} mm`, { style: 'TRule' })])).join('')}
  </table:table>`;
  return fodt({
    title: 'Tables',
    automatic: TABLE_STYLES + columnStyles('Inv', widths) + columnStyles('Rul', ['5cm', '6cm', '6cm']),
    content: [p('Title', 'Workshop Inventory'), body(paragraph(3)), table, body(paragraph(2)), ruled, body(paragraph(4))].join(''),
  });
};

documents['table-long'] = () => {
  seed = 55;
  const widths = ['2cm', '6cm', '4.5cm', '4.5cm'];
  const head = (text) => cell(text, { style: 'THead', paragraph: 'THeadText' });
  const rows = Array.from({ length: 70 }, (_, index) => row([
    cell(String(index + 1), { style: index % 2 ? 'TShade' : 'TCell' }),
    cell(`${pick(['Tide', 'Wind', 'Lantern', 'Ferry', 'Net'])} log ${pick(['north', 'south', 'east', 'west'])}`, { style: index % 2 ? 'TShade' : 'TCell' }),
    cell(`${(random() * 90 + 5).toFixed(1)} units`, { style: index % 2 ? 'TShade' : 'TCell' }),
    cell(pick(['checked', 'pending', 'repeated', 'archived']), { style: index % 2 ? 'TShade' : 'TCell' }),
  ]));
  const table = `<table:table table:name="Log" table:style-name="Tbl">${columns('Log', widths)}
    <table:table-header-rows>${row([head('No.'), head('Entry'), head('Value'), head('Status')])}</table:table-header-rows>${rows.join('')}</table:table>`;
  return fodt({
    title: 'Long table', automatic: TABLE_STYLES + columnStyles('Log', widths),
    content: [p('Title', 'Seasonal Observation Log'), body(paragraph(2)), table, body(paragraph(2))].join(''),
  });
};

documents['images'] = () => {
  seed = 66;
  const automatic = `
    <style:style style:name="frImage" style:family="graphic"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>
    <style:style style:name="frWrap" style:family="graphic"><style:graphic-properties style:wrap="parallel" style:number-wrapped-paragraphs="no-limit" fo:margin-left="0.3cm" fo:margin-right="0cm" fo:margin-bottom="0.2cm" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="right" style:horizontal-rel="paragraph"/></style:style>
    <style:style style:name="frBlock" style:family="graphic"><style:graphic-properties style:wrap="none" fo:margin-top="0.2cm" fo:margin-bottom="0.2cm" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="center" style:horizontal-rel="paragraph"/></style:style>
    <style:style style:name="Centered" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>`;
  const content = [
    p('Title', 'Pictures from the Fictional Fair'),
    p('Text_20_body', `An inline badge ${image({ name: 'Badge', data: BADGE_PNG, width: '1cm', height: '1cm' })} sits inside this sentence, followed by more text. ${escape(paragraph(2))}`),
    p('Centered', image({ name: 'Chart', data: CHART_PNG, width: '9cm', height: '6cm' })),
    p('Caption', 'Figure 1. Invented visitor numbers for three stalls.'),
    p('Text_20_body', `${image({ name: 'Landscape', data: LANDSCAPE_JPEG, width: '6cm', height: '4cm', anchor: 'paragraph', style: 'frWrap' })}${escape(paragraph(6))}`),
    body(paragraph(4)),
    p('Standard', image({ name: 'ChartBlock', data: CHART_PNG, width: '12cm', height: '8cm', anchor: 'paragraph', style: 'frBlock' })),
    body(paragraph(4)),
  ].join('');
  return fodt({ title: 'Images', automatic, content });
};

documents['notes'] = () => {
  seed = 77;
  let footnote = 0;
  let endnote = 0;
  const fn = (text) => `<text:note text:id="ftn${++footnote}" text:note-class="footnote"><text:note-citation>${footnote}</text:note-citation><text:note-body>${p('Footnote', escape(text))}</text:note-body></text:note>`;
  const en = (text) => `<text:note text:id="edn${++endnote}" text:note-class="endnote"><text:note-citation>${['i', 'ii', 'iii', 'iv'][endnote - 1]}</text:note-citation><text:note-body>${p('Endnote', escape(text))}</text:note-body></text:note>`;
  const content = [
    p('Title', 'A Short History of the Ferry'),
    ...Array.from({ length: 9 }, (_, index) => p('Text_20_body', `${escape(paragraph(4))}${index % 2 === 0 ? fn(paragraph(1)) : ''} ${escape(paragraph(2))}${index % 3 === 1 ? en(paragraph(1)) : ''}`)),
  ].join('');
  return fodt({ title: 'Notes', content });
};

documents['header-footer'] = () => {
  seed = 88;
  const masters = `
    <style:master-page style:name="First_20_Page" style:display-name="First Page" style:page-layout-name="pm1" style:next-style-name="Standard">
      <style:header>${p('Header', 'Brindlemoor Survey<text:tab/><text:tab/>Cover page')}</style:header>
    </style:master-page>
    <style:master-page style:name="Standard" style:page-layout-name="pm2">
      <style:header>${p('Header', 'Brindlemoor Survey<text:tab/>Interim report<text:tab/>Fictional data')}</style:header>
      <style:footer>${p('Footer', '<text:tab/>Page <text:page-number text:select-page="current">2</text:page-number> of <text:page-count>4</text:page-count><text:tab/>')}</style:footer>
    </style:master-page>`;
  const automatic = '<style:style style:name="FirstTitle" style:family="paragraph" style:parent-style-name="Title" style:master-page-name="First_20_Page"/>';
  return fodt({
    title: 'Header and footer', automatic,
    layouts: pageLayout('pm1', { header: true }) + pageLayout('pm2', { header: true, footer: true }),
    masters,
    content: [p('FirstTitle', 'Interim Report on the Brindlemoor Survey'), ...Array.from({ length: 14 }, () => body(paragraph(6)))].join(''),
  });
};

documents['landscape-sections'] = () => {
  seed = 99;
  const widths = Array.from({ length: 8 }, () => '3.2cm');
  const head = (text) => cell(text, { style: 'THead', paragraph: 'THeadText' });
  const months = ['Station', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
  const wide = `<table:table table:name="Wide" table:style-name="TblWide">${columns('Wide', widths)}
    <table:table-header-rows>${row(months.map(head))}</table:table-header-rows>
    ${['North pier', 'Old mill', 'Dune path', 'Signal hill', 'Ferry ramp', 'Chapel road'].map((name) => row([cell(name), ...months.slice(1).map(() => cell((random() * 50).toFixed(1)))])).join('')}
  </table:table>`;
  const automatic = `
    <style:style style:name="TblWide" style:family="table"><style:table-properties style:width="25.6cm" table:align="margins"/></style:style>
    ${columnStyles('Wide', widths)}
    <style:style style:name="ToLandscape" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Landscape"/>
    <style:style style:name="ToPortrait" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Standard"/>`;
  return fodt({
    title: 'Landscape section', automatic: TABLE_STYLES + automatic,
    layouts: pageLayout('pm1') + pageLayout('pm2', { width: '29.7cm', height: '21cm', orientation: 'landscape' }),
    masters: '<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Landscape" style:page-layout-name="pm2"/>',
    content: [p('Title', 'Rainfall by Station'), body(paragraph(6)), body(paragraph(6)),
      p('ToLandscape', 'Monthly readings (landscape page)'), body(paragraph(3)), wide,
      p('ToPortrait', 'Discussion'), body(paragraph(6)), body(paragraph(5))].join(''),
  });
};

documents['math-formula'] = () => {
  seed = 111;
  const formula = (name, mathml, starmath, width, height) => `<draw:frame draw:style-name="frMath" draw:name="${name}" text:anchor-type="as-char" svg:width="${width}" svg:height="${height}" draw:z-index="0"><draw:object><math:math display="block"><math:semantics>${mathml}<math:annotation encoding="StarMath 5.0">${escape(starmath)}</math:annotation></math:semantics></math:math></draw:object></draw:frame>`;
  const quadratic = formula('Quadratic', '<math:mrow><math:mi>x</math:mi><math:mo>=</math:mo><math:mfrac><math:mrow><math:mo>-</math:mo><math:mi>b</math:mi><math:mo>±</math:mo><math:msqrt><math:mrow><math:msup><math:mi>b</math:mi><math:mn>2</math:mn></math:msup><math:mo>-</math:mo><math:mn>4</math:mn><math:mi>a</math:mi><math:mi>c</math:mi></math:mrow></math:msqrt></math:mrow><math:mrow><math:mn>2</math:mn><math:mi>a</math:mi></math:mrow></math:mfrac></math:mrow>',
    'x = {-b +- sqrt{b^2 - 4 a c}} over {2 a}', '4.5cm', '1.6cm');
  const sum = formula('Sum', '<math:mrow><math:munderover><math:mo>∑</math:mo><math:mrow><math:mi>k</math:mi><math:mo>=</math:mo><math:mn>1</math:mn></math:mrow><math:mi>n</math:mi></math:munderover><math:msup><math:mi>k</math:mi><math:mn>2</math:mn></math:msup><math:mo>=</math:mo><math:mfrac><math:mrow><math:mi>n</math:mi><math:mo stretchy="false">(</math:mo><math:mi>n</math:mi><math:mo>+</math:mo><math:mn>1</math:mn><math:mo stretchy="false">)</math:mo><math:mo stretchy="false">(</math:mo><math:mn>2</math:mn><math:mi>n</math:mi><math:mo>+</math:mo><math:mn>1</math:mn><math:mo stretchy="false">)</math:mo></math:mrow><math:mn>6</math:mn></math:mfrac></math:mrow>',
    'sum from {k=1} to n k^2 = {n(n+1)(2n+1)} over 6', '5.5cm', '1.8cm');
  const automatic = `<style:style style:name="frMath" style:family="graphic"><style:graphic-properties style:vertical-pos="middle" style:vertical-rel="text"/></style:style>
    <style:style style:name="Centered" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:text-align="center"/></style:style>`;
  return fodt({
    title: 'Formulas', automatic,
    content: [p('Title', 'Exercise Sheet: Fictional Algebra'), body(paragraph(3)),
      p('Text_20_body', '1. Solve the equation using the quadratic formula:'), p('Centered', quadratic), body(paragraph(2)),
      p('Text_20_body', '2. Check the closed form of the sum of squares:'), p('Centered', sum), body(paragraph(4))].join(''),
  });
};

documents['breaks'] = () => {
  seed = 122;
  const automatic = `
    <style:style style:name="BreakBefore" style:family="paragraph" style:parent-style-name="Heading_20_1"><style:paragraph-properties fo:break-before="page"/></style:style>
    <style:style style:name="NewSection" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Wide_20_Margins"/>
    <style:style style:name="BackSection" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Standard"/>
    <style:style style:name="Sect2" style:family="section"><style:section-properties text:dont-balance-text-columns="false"><style:columns fo:column-count="2" fo:column-gap="0.8cm"><style:column style:rel-width="1*" fo:start-indent="0cm" fo:end-indent="0.4cm"/><style:column style:rel-width="1*" fo:start-indent="0.4cm" fo:end-indent="0cm"/></style:columns></style:section-properties></style:style>`;
  return fodt({
    title: 'Breaks', automatic,
    layouts: pageLayout('pm1') + pageLayout('pm2', { margin: '3.5cm' }),
    masters: '<style:master-page style:name="Standard" style:page-layout-name="pm1"/><style:master-page style:name="Wide_20_Margins" style:display-name="Wide Margins" style:page-layout-name="pm2"/>',
    content: [p('Title', 'Breaks and Sections'), body(paragraph(4)),
      p('BreakBefore', 'Second page after a page break'), body(paragraph(5)),
      p('NewSection', 'A new section with wide margins'), body(paragraph(6)), body(paragraph(4)),
      p('BackSection', 'Back to normal margins'), body(paragraph(3)),
      `<text:section text:style-name="Sect2" text:name="TwoColumns">${body(paragraph(6))}${body(paragraph(6))}</text:section>`,
      body(paragraph(3))].join(''),
  });
};

documents['text-boxes'] = () => {
  seed = 133;
  const automatic = `
    <style:style style:name="frBox" style:family="graphic"><style:graphic-properties fo:border="0.75pt solid #1f3b5c" draw:fill="solid" draw:fill-color="#e8eef6" fo:background-color="#e8eef6" fo:padding="0.25cm" style:wrap="parallel" style:number-wrapped-paragraphs="no-limit" fo:margin-left="0.3cm" fo:margin-bottom="0.2cm" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="right" style:horizontal-rel="paragraph"/></style:style>
    <style:style style:name="frBoxFull" style:family="graphic"><style:graphic-properties fo:border="1.5pt solid #8a4b08" draw:fill="solid" draw:fill-color="#fff3e0" fo:background-color="#fff3e0" fo:padding="0.3cm" style:wrap="none" fo:margin-top="0.2cm" fo:margin-bottom="0.3cm" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="center" style:horizontal-rel="paragraph"/></style:style>`;
  const box = (name, style, width, height, paragraphs) => `<draw:frame draw:style-name="${style}" draw:name="${name}" text:anchor-type="paragraph" svg:width="${width}" fo:min-height="${height}" draw:z-index="1"><draw:text-box>${paragraphs.join('')}</draw:text-box></draw:frame>`;
  return fodt({
    title: 'Text boxes', automatic,
    content: [p('Title', 'Visitor Guide to the Lighthouse'),
      p('Text_20_body', `${box('Tip', 'frBox', '6cm', '3cm', [p('Frame_20_contents', '<text:span text:style-name="Bold">Tip:</text:span> bring a warm coat; the gallery is windy even in summer.'), p('Frame_20_contents', escape(words(18)))])}${escape(paragraph(8))}`),
      body(paragraph(4)),
      p('Standard', box('Notice', 'frBoxFull', '15cm', '2.5cm', [p('Frame_20_contents', '<text:span text:style-name="Bold">Notice.</text:span> The stairs close at sunset. This notice is fictional and only tests text boxes that span the text width.')])),
      body(paragraph(5)), body(paragraph(4))].join(''),
  });
};

documents['mixed-fonts'] = () => {
  seed = 144;
  const automatic = `
    ${[8, 10, 14, 20, 28].map((size) => `<style:style style:name="Size${size}" style:family="paragraph" style:parent-style-name="Text_20_body"><style:text-properties fo:font-size="${size}pt"/></style:style>`).join('')}
    <style:style style:name="Sans" style:family="text"><style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'"/></style:style>
    <style:style style:name="Mono" style:family="text"><style:text-properties style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'" fo:font-size="10pt"/></style:style>
    <style:style style:name="Red" style:family="text"><style:text-properties fo:color="#b00020" fo:font-weight="bold"/></style:style>
    <style:style style:name="Under" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
    <style:style style:name="Mark" style:family="text"><style:text-properties fo:background-color="#ffff00"/></style:style>
    <style:style style:name="Sup" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
    <style:style style:name="Code" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1cm" fo:background-color="#f0f0f0" fo:padding="0.1cm"/><style:text-properties style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'" fo:font-size="9pt"/></style:style>
    <style:style style:name="Right" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:text-align="end"/><style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans'" fo:font-style="italic"/></style:style>`;
  return fodt({
    title: 'Mixed fonts', automatic,
    content: [p('Size28', 'A very large opening line'), p('Size20', 'A large subtitle in twenty points'),
      p('Text_20_body', `${escape(words(12))} ${span('Sans', words(10))} ${span('Mono', 'mono_spaced(code)')} ${span('Red', 'bold red words')} ${span('Under', 'underlined phrase')} ${span('Mark', 'highlighted text')} E = mc${span('Sup', '2')} ${span('Italic', words(8))}. ${escape(paragraph(3))}`),
      p('Size14', escape(paragraph(3))), p('Size10', escape(paragraph(5))), p('Size8', escape(paragraph(8))),
      ...['function lanternCount(nights) {', '  return nights * 3 + 1; // fictional', '}'].map((line) => p('Code', escape(line))),
      p('Right', 'Signed by the fictional harbour office.'), p('Size14', escape(paragraph(4))), p('Size20', escape(paragraph(2)))].join(''),
  });
};

// ---------------------------------------------------------------------------
const run = (argv) => {
  try {
    return execFileSync(soffice, argv, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }).toString();
  } catch (error) {
    throw new Error(`LibreOffice failed:\n${error.stdout || ''}${error.stderr || ''}`);
  }
};

const names = Object.keys(documents).filter((name) => !only || only.includes(name));
await mkdir(sourceDir, { recursive: true });
await mkdir(referenceDir, { recursive: true });
for (const name of names) await writeFile(join(sourceDir, `${name}.fodt`), documents[name]());
console.log(`Wrote ${names.length} Flat ODT sources to ${sourceDir}`);

if (!soffice) {
  console.log('LibreOffice was not found (set SOFFICE or pass --soffice); the existing DOCX, ODT and reference PDFs were kept.');
  process.exit(0);
}
// A private profile lets the conversion run while the user has LibreOffice open.
const work = await mkdtemp(join(tmpdir(), 'moodlia-fidelity-'));
const profile = `-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`;
const base = ['--headless', '--norestore', '--nologo', profile];
try {
  const sources = names.map((name) => join(sourceDir, `${name}.fodt`));
  run([...base, '--convert-to', 'odt', '--outdir', root, ...sources]);
  run([...base, '--convert-to', 'docx:MS Word 2007 XML', '--outdir', root, ...sources]);
  // The ODT preview thumbnail is about 45 kB per file and plays no part in layout; drop it
  // before the reference PDFs are printed, so the stored ODT is exactly what is measured.
  for (const name of names) {
    const path = join(root, `${name}.odt`);
    const entries = unzipSync(await readFile(path));
    const kept = Object.fromEntries(Object.entries(entries).filter(([entry]) => !entry.startsWith('Thumbnails/')));
    kept['META-INF/manifest.xml'] = strToU8(strFromU8(kept['META-INF/manifest.xml']).replace(/\s*<manifest:file-entry[^>]*Thumbnails\/[^>]*\/>/g, ''));
    const { mimetype, ...rest } = kept;
    await writeFile(path, zipSync({ mimetype: [mimetype, { level: 0 }], ...rest }, { level: 9 }));
  }
  for (const format of ['odt', 'docx']) {
    const out = join(work, format);
    await mkdir(out, { recursive: true });
    run([...base, '--convert-to', 'pdf', '--outdir', out, ...names.map((name) => join(root, `${name}.${format}`))]);
    for (const file of await readdir(out)) await copyFile(join(out, file), join(referenceDir, file.replace(/\.pdf$/, `.${format}.pdf`)));
  }
  for (const name of names) {
    for (const file of [`${name}.odt`, `${name}.docx`, `reference/${name}.odt.pdf`, `reference/${name}.docx.pdf`]) {
      if (!existsSync(join(root, file))) throw new Error(`LibreOffice did not produce ${file}.`);
    }
  }
  console.log(`Converted ${names.length} documents to ODT, DOCX and reference PDFs with ${soffice}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
