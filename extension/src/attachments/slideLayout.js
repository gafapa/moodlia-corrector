// Presentations (PPTX and ODP): one page per visible slide at the presentation's
// slide size. Shapes are placed absolutely: text boxes and placeholders (PPTX
// positions and text styles inherited from the slide layout and master),
// pictures, solid and gradient fills, outlines, tables, groups and connectors.
// Charts, SmartArt, embedded objects and media are marked with a placeholder.
// Both formats are first read into one slide model, which a single renderer draws.
import { BORDER, applyCss, createImageSources, createLimitations, formatNumber, html, imageLoaded, isColor, isLength, mappedText, paginateAndRender, placeholder, toPx } from './pageLayout.js';
import { EMU_PER_PX, child, childrenNamed, colorCss, createPackage, descendant, elements, fontStack, readTheme, relationId, resolveColor, rgbOf, val } from './drawingml.js';
import { createOdfStyles, odfAttr, odfIs, odfRuns, odfTextCss } from './sheetLayout.js';

const MAX_SHAPES = 5000;
const MAX_TABLE_CELLS = 20_000;
const MAX_GROUP_DEPTH = 20;
const MAX_SLIDES = 60;
const pageLimit = (message) => Object.assign(new Error(message), { code: 'PAGE_LIMIT' });
const emu = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) / EMU_PER_PX : fallback;
const round = (value) => Math.round(value * 100) / 100;
const px = (value) => `${round(value)}px`;

// Simple preset shapes as polygons (fractions of the shape box); other presets are drawn as rectangles.
const POLYGONS = {
  triangle: [[0.5, 0], [1, 1], [0, 1]], rtTriangle: [[0, 0], [1, 1], [0, 1]], diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  parallelogram: [[0.25, 0], [1, 0], [0.75, 1], [0, 1]], trapezoid: [[0.25, 0], [0.75, 0], [1, 1], [0, 1]],
  pentagon: [[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]], hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  homePlate: [[0, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0, 1]], chevron: [[0, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0, 1], [0.2, 0.5]],
  rightArrow: [[0, 0.25], [0.7, 0.25], [0.7, 0], [1, 0.5], [0.7, 1], [0.7, 0.75], [0, 0.75]],
  leftArrow: [[1, 0.25], [0.3, 0.25], [0.3, 0], [0, 0.5], [0.3, 1], [0.3, 0.75], [1, 0.75]],
  upArrow: [[0.25, 1], [0.25, 0.3], [0, 0.3], [0.5, 0], [1, 0.3], [0.75, 0.3], [0.75, 1]],
  downArrow: [[0.25, 0], [0.25, 0.7], [0, 0.7], [0.5, 1], [1, 0.7], [0.75, 0.7], [0.75, 0]],
  star5: [[0.5, 0], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.5, 0.7], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]],
};
const ODP_SHAPES = {
  rectangle: 'rect', 'round-rectangle': 'roundRect', ellipse: 'ellipse', circle: 'ellipse', 'isosceles-triangle': 'triangle', 'right-triangle': 'rtTriangle',
  diamond: 'diamond', parallelogram: 'parallelogram', trapezoid: 'trapezoid', pentagon: 'pentagon', hexagon: 'hexagon', 'right-arrow': 'rightArrow',
  'left-arrow': 'leftArrow', 'up-arrow': 'upArrow', 'down-arrow': 'downArrow', chevron: 'chevron', star5: 'star5', 'pentagon-right': 'homePlate',
};
const RECTANGLES = new Set(['rect', 'roundRect', 'ellipse', 'snip1Rect', 'round1Rect', 'round2SameRect', 'flowChartProcess', 'flowChartAlternateProcess', 'textBox', 'frame']);

const textLimit = (label) => new Error(`${label} exceeds the text or image limit.`);
const createBudget = (label, maxText) => {
  let shapes = 0;
  let cells = 0;
  let text = 0;
  return {
    shape: () => { if (++shapes > MAX_SHAPES) throw pageLimit(`${label} exceeds the ${MAX_SHAPES} shape limit.`); },
    cells: (count) => { cells += count; if (cells > MAX_TABLE_CELLS) throw pageLimit(`${label} tables exceed the ${MAX_TABLE_CELLS} cell limit.`); },
    text: (length) => { text += length; if (text > maxText) throw textLimit(label); },
  };
};
const paragraphRunsText = (paragraph) => paragraph.runs.map(run => run.text).join('');

// ---- PPTX ----
const MASTER_TYPE = { title: 'title', ctrTitle: 'title', dt: 'dt', ftr: 'ftr', sldNum: 'sldNum' };
const AUTONUM = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain)$/;
const SYMBOL_BULLETS = { 'Ø': '➢', '§': '▪', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'Ÿ': '•', 'à': '➔', 'o': '○', 'w': '◆' };
// The built-in "Medium Style 2 - Accent 1" table style, which PowerPoint does not write into the file.
const DEFAULT_TABLE_STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';

export const readPptxPresentation = ({ entries, signal, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels, maxText = Infinity }) => {
  const label = 'PPTX';
  const pkg = createPackage(entries);
  const presentationPath = [...pkg.rels('').values()].find(relation => relation.type.endsWith('/officeDocument'))?.path || 'ppt/presentation.xml';
  const presentationDoc = pkg.parse(presentationPath);
  if (!presentationDoc) throw new Error('Invalid PPTX XML.');
  const budget = createBudget(label, maxText);
  const limitations = createLimitations();
  const hidden = { count: 0 };
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const size = descendant(presentationDoc, 'sldSz');
  const width = Math.min(8000, Math.max(50, emu(val(size, 'cx'), 960)));
  const height = Math.min(8000, Math.max(50, emu(val(size, 'cy'), 540)));
  const defaultTextStyle = child(presentationDoc.documentElement, 'defaultTextStyle');
  const tableStyles = pkg.parse(pkg.relatedByType(presentationPath, '/tableStyles')[0]?.path || 'ppt/tableStyles.xml');
  const slidePaths = childrenNamed(descendant(presentationDoc, 'sldIdLst'), 'sldId').map(slide => pkg.related(presentationPath, relationId(slide))?.path).filter(Boolean);
  if (slidePaths.length > 1000) throw pageLimit(`${label} exceeds the 60 page limit.`);

  const templates = new Map();
  const template = (path) => {
    if (!templates.has(path)) {
      const doc = pkg.parse(path);
      const placeholders = [];
      for (const node of elements(descendant(doc, 'spTree'))) {
        const ph = descendant(child(node, 'nvSpPr') || child(node, 'nvPicPr') || child(node, 'nvGraphicFramePr'), 'ph');
        if (ph) placeholders.push({ node, type: val(ph, 'type') || 'obj', idx: val(ph, 'idx') });
      }
      templates.set(path, { doc, placeholders });
    }
    return templates.get(path);
  };
  const themes = new Map();
  const themeOf = (masterPath) => {
    if (!themes.has(masterPath)) {
      const path = pkg.relatedByType(masterPath, '/theme')[0]?.path;
      const doc = path ? pkg.parse(path) : null;
      themes.set(masterPath, { ...readTheme(doc), doc });
    }
    return themes.get(masterPath);
  };
  const colorMap = (node) => node ? Object.fromEntries([...node.attributes].map(attribute => [attribute.localName, attribute.value])) : null;
  const visibleText = (root) => [...root?.getElementsByTagNameNS('*', 't') || []].filter(text => text.textContent.trim()).length;

  // Fills: none, solid, gradient (CSS gradient plus a middle colour for contrast checks), picture or pattern.
  const fillOf = (node, context, part) => {
    if (!node) return undefined;
    if (node.localName === 'noFill') return null;
    if (node.localName === 'solidFill') { const color = resolveColor(node, context); return color ? { color } : null; }
    if (node.localName === 'gradFill') {
      const stops = childrenNamed(child(node, 'gsLst'), 'gs').map(stop => ({ color: resolveColor(stop, context), position: Math.min(100, Math.max(0, (Number(val(stop, 'pos')) || 0) / 1000)) })).filter(stop => stop.color);
      if (!stops.length) return null;
      const angle = 90 + (Number(val(child(node, 'lin'), 'ang')) || 0) / 60000;
      return { color: stops[Math.floor(stops.length / 2)].color, css: stops.length > 1 ? `linear-gradient(${round(angle)}deg, ${stops.map(stop => `${colorCss(stop.color)} ${round(stop.position)}%`).join(', ')})` : null };
    }
    if (node.localName === 'pattFill') { const color = resolveColor(child(node, 'fgClr'), context); return color ? { color } : null; }
    if (node.localName === 'blipFill') {
      const picture = pictureOf(node, part);
      return picture?.src ? { image: picture.src } : null;
    }
    return undefined;
  };
  const FILLS = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill'];
  const fillChild = (node) => elements(node).find(item => FILLS.includes(item.localName)) || null;
  const pictureOf = (blipFill, part) => {
    const blip = child(blipFill, 'blip');
    const relation = pkg.related(part, val(blip, 'embed') || val(blip, 'link'));
    const source = !relation ? { format: 'unknown', limitation: 'unsupported-embedded-image-format' } : relation.external ? { format: 'link', limitation: 'external-linked-image' } : imageSource(relation.path);
    if (!source.src) {
      limitations.add(source.limitation, source.format);
      return { missing: `[Image not shown: ${source.format.toUpperCase()}]` };
    }
    const rect = child(blipFill, 'srcRect');
    const crop = Object.fromEntries(['l', 't', 'r', 'b'].map(side => [side, Math.min(0.95, Math.max(-1, (Number(val(rect, side)) || 0) / 100000))]));
    return { src: source.src, crop };
  };

  // Text: master text styles, then master, layout and shape list styles, then paragraph and run properties.
  const textOf = (txBody, layers, context, kind, fontColor) => {
    if (!txBody) return null;
    const bodies = [...layers.map(layer => child(layer, 'bodyPr')), child(txBody, 'bodyPr')].filter(Boolean);
    const bodyValue = (name) => { for (const body of [...bodies].reverse()) if (val(body, name) !== null) return val(body, name); return null; };
    const autofit = [...bodies].reverse().map(body => child(body, 'normAutofit')).find(Boolean);
    const fontScale = Math.min(1, Math.max(0.1, (Number(val(autofit, 'fontScale')) || 100000) / 100000));
    const spacingReduction = Math.min(0.9, (Number(val(autofit, 'lnSpcReduction')) || 0) / 100000);
    const masterStyle = kind === 'title' ? child(context.txStyles, 'titleStyle') : kind === 'body' ? child(context.txStyles, 'bodyStyle') : child(context.txStyles, 'otherStyle');
    // A style reference colour (fontRef, table style text) overrides the master text styles, not the shape's own.
    const baseLists = [...(kind === 'other' ? [defaultTextStyle] : []), masterStyle].filter(Boolean);
    const lists = [...baseLists, ...layers.map(layer => child(layer, 'lstStyle')), child(txBody, 'lstStyle')].filter(Boolean);
    const counters = [];
    const paragraphs = [];
    for (const paragraph of childrenNamed(txBody, 'p')) {
      const properties = child(paragraph, 'pPr');
      const level = Math.min(8, Math.max(0, Number(val(properties, 'lvl')) || 0));
      const levels = [...lists.map(list => child(list, `lvl${level + 1}pPr`)).filter(Boolean), ...(properties ? [properties] : [])];
      const pick = (read) => { for (const node of [...levels].reverse()) { const value = read(node); if (value !== undefined && value !== null) return value; } return undefined; };
      const baseLevels = new Set(baseLists.map(list => child(list, `lvl${level + 1}pPr`)).filter(Boolean));
      const runLayers = levels.map(node => child(node, 'defRPr')).filter(Boolean);
      const baseRuns = new Set([...baseLevels].map(node => child(node, 'defRPr')).filter(Boolean));
      const runCss = (rPr) => {
        const stack = [...runLayers, ...(rPr ? [rPr] : [])];
        const get = (read) => { for (const node of [...stack].reverse()) { const value = read(node); if (value !== undefined && value !== null) return value; } return undefined; };
        const css = {};
        const sizeValue = get(node => val(node, 'sz'));
        const points = Number(sizeValue) > 0 ? Math.min(4000, Number(sizeValue) / 100) : 18;
        css['font-size'] = `${round(points * fontScale)}pt`;
        if (get(node => val(node, 'b')) !== undefined) css['font-weight'] = ['1', 'true'].includes(get(node => val(node, 'b'))) ? 'bold' : 'normal';
        if (get(node => val(node, 'i')) !== undefined) css['font-style'] = ['1', 'true'].includes(get(node => val(node, 'i'))) ? 'italic' : 'normal';
        const lines = [];
        const underline = get(node => val(node, 'u'));
        if (underline && underline !== 'none') lines.push('underline');
        const strike = get(node => val(node, 'strike'));
        if (strike && strike !== 'noStrike') lines.push('line-through');
        if (lines.length) css['text-decoration-line'] = lines.join(' ');
        const cap = get(node => val(node, 'cap'));
        if (cap === 'all') css['text-transform'] = 'uppercase'; else if (cap === 'small') css['font-variant'] = 'small-caps';
        const baseline = Number(get(node => val(node, 'baseline')));
        if (baseline) Object.assign(css, { 'vertical-align': baseline > 0 ? 'super' : 'sub', 'font-size': `${round(points * fontScale * 0.65)}pt` });
        const fillFrom = (base) => get((node) => {
          const fillNode = baseRuns.has(node) === base ? fillChild(node) : null;
          if (!fillNode) return undefined;
          const resolved = fillOf(fillNode, context);
          return resolved === null ? { color: { r: 0, g: 0, b: 0, a: 0 } } : resolved;
        });
        const color = fillFrom(false)?.color || fontColor || fillFrom(true)?.color || context.colors?.[context.map?.tx1 || 'dk1'] || rgbOf('000000');
        css.color = colorCss(color);
        const typeface = get(node => val(child(node, 'latin'), 'typeface'));
        const family = fontStack(typeface === '+mj-lt' ? context.fonts.major : !typeface || typeface === '+mn-lt' ? (kind === 'title' ? context.fonts.major : context.fonts.minor) : typeface);
        if (family) css['font-family'] = family;
        const highlight = rPr && resolveColor(child(rPr, 'highlight'), context);
        if (highlight) css['background-color'] = colorCss(highlight);
        return css;
      };
      const css = {};
      const align = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[pick(node => val(node, 'algn'))];
      if (align) css['text-align'] = align;
      const marginLeft = emu(pick(node => val(node, 'marL')), 0);
      const indent = emu(pick(node => val(node, 'indent')), 0);
      css['padding-left'] = px(Math.max(0, marginLeft));
      css['text-indent'] = px(indent);
      const spacing = (name) => pick(node => child(node, name) ? child(node, name) : undefined);
      const lineSpacing = spacing('lnSpc');
      if (child(lineSpacing, 'spcPct')) css['line-height'] = String(round(Math.max(0.5, 1.2 * Number(val(child(lineSpacing, 'spcPct'))) / 100000 * (1 - spacingReduction))));
      else if (child(lineSpacing, 'spcPts')) css['line-height'] = `${round(Number(val(child(lineSpacing, 'spcPts'))) / 100 * fontScale)}pt`;
      else if (spacingReduction) css['line-height'] = String(round(1.2 * (1 - spacingReduction)));
      for (const [name, property] of [['spcBef', 'margin-top'], ['spcAft', 'margin-bottom']]) {
        const space = spacing(name);
        if (child(space, 'spcPts')) css[property] = `${round(Math.min(1000, Number(val(child(space, 'spcPts'))) / 100))}pt`;
        else if (child(space, 'spcPct')) css[property] = `${round(Math.min(10, Number(val(child(space, 'spcPct'))) / 100000 * 1.2))}em`;
      }
      const runs = [];
      for (const item of elements(paragraph)) {
        if (item.localName === 'br') runs.push({ text: '\n', css: runCss(child(item, 'rPr')) });
        else if (['r', 'fld'].includes(item.localName)) {
          const text = child(item, 't')?.textContent || '';
          if (text) runs.push({ text, css: runCss(child(item, 'rPr')) });
        }
      }
      budget.text(runs.reduce((sum, run) => sum + run.text.length, 0));
      let bullet = null;
      const bulletNode = pick(node => elements(node).find(item => ['buNone', 'buChar', 'buAutoNum', 'buBlip'].includes(item.localName)));
      if (bulletNode?.localName === 'buAutoNum') {
        counters.length = level + 1;
        const start = Number(val(bulletNode, 'startAt')) || 1;
        counters[level] = counters[level] === undefined ? start : counters[level] + 1;
        const [, kindName, punctuation] = AUTONUM.exec(val(bulletNode, 'type') || '') || [, 'arabic', 'Period'];
        const value = formatNumber(counters[level], { arabic: '1', alphaLc: 'a', alphaUc: 'A', romanLc: 'i', romanUc: 'I' }[kindName]);
        bullet = { text: punctuation === 'ParenR' ? `${value})` : punctuation === 'ParenBoth' ? `(${value})` : punctuation === 'Plain' ? value : `${value}.` };
      } else {
        if (runs.length) counters[level] = undefined;
        counters.length = level + 1;
        if (bulletNode?.localName === 'buChar') {
          const character = [...(val(bulletNode, 'char') || '•')][0] || '•';
          const font = pick(node => val(child(node, 'buFont'), 'typeface')) || '';
          const code = character.codePointAt(0);
          bullet = { text: /wingdings|symbol/i.test(font) ? SYMBOL_BULLETS[character] || '•' : code >= 0xe000 && code <= 0xf8ff ? '•' : character };
        } else if (bulletNode?.localName === 'buBlip') bullet = { text: '•' };
      }
      const firstCss = runs[0]?.css || runCss(child(paragraph, 'endParaRPr'));
      if (bullet) {
        const bulletColor = resolveColor(pick(node => child(node, 'buClr') || undefined), context);
        const scale = (Number(val(pick(node => child(node, 'buSzPct') || undefined), 'val')) || 100000) / 100000;
        bullet.css = { color: bulletColor ? colorCss(bulletColor) : firstCss.color, 'font-size': `${round(parseFloat(firstCss['font-size']) * Math.min(4, Math.max(0.25, scale)))}pt`, 'font-weight': firstCss['font-weight'] || 'normal' };
        bullet.width = Math.max(0, -indent);
      }
      paragraphs.push({ css, bullet: runs.some(run => run.text.trim()) ? bullet : null, runs, size: firstCss['font-size'], level });
    }
    if (!paragraphs.some(paragraph => paragraph.runs.some(run => run.text.trim()))) return null;
    const anchor = { t: 'top', ctr: 'middle', b: 'bottom', just: 'middle', dist: 'middle' }[bodyValue('anchor')] || 'top';
    return {
      paragraphs, anchor, wrap: bodyValue('wrap') !== 'none',
      insets: { left: emu(bodyValue('lIns'), 9.6), top: emu(bodyValue('tIns'), 4.8), right: emu(bodyValue('rIns'), 9.6), bottom: emu(bodyValue('bIns'), 4.8) },
    };
  };

  const tableStyleParts = (id, context) => {
    const node = [...tableStyles?.getElementsByTagNameNS('*', 'tblStyle') || []].find(style => val(style, 'styleId') === id);
    if (!node) {
      if (id !== DEFAULT_TABLE_STYLE) return null;
      const accent = context.colors.accent1 || rgbOf('4472C4');
      const light = context.colors.lt1 || rgbOf('FFFFFF');
      const dark = context.colors.dk1 || rgbOf('000000');
      const tint = (amount) => ({ r: accent.r * amount + 255 * (1 - amount), g: accent.g * amount + 255 * (1 - amount), b: accent.b * amount + 255 * (1 - amount), a: 1 });
      const white = { color: light, width: 1.33 };
      return {
        wholeTbl: { fill: tint(0.2), text: { color: dark }, borders: { left: white, right: white, top: white, bottom: white, insideH: white, insideV: white } },
        band1H: { fill: tint(0.4) }, firstRow: { fill: accent, text: { color: light, bold: true }, borders: { bottom: { color: light, width: 4 } } },
        lastRow: { fill: accent, text: { color: light, bold: true } }, firstCol: { fill: accent, text: { color: light, bold: true } }, lastCol: { fill: accent, text: { color: light, bold: true } },
      };
    }
    const parts = {};
    for (const part of elements(node)) {
      const textStyle = child(part, 'tcTxStyle');
      const cellStyle = child(part, 'tcStyle');
      const fill = fillOf(fillChild(child(cellStyle, 'fill')), context) || (child(cellStyle, 'fillRef') ? { color: resolveColor(child(cellStyle, 'fillRef'), context) } : null);
      const borders = {};
      for (const side of elements(child(cellStyle, 'tcBdr'))) {
        const line = child(side, 'ln');
        const color = resolveColor(child(line, 'solidFill'), context) || (child(side, 'lnRef') ? resolveColor(child(side, 'lnRef'), context) : null);
        if (child(line, 'noFill')) borders[side.localName] = null;
        else if (color) borders[side.localName] = { color, width: Math.max(0.75, emu(val(line, 'w'), 1)) };
      }
      parts[part.localName] = {
        fill: fill?.color || null, borders,
        text: textStyle ? { color: resolveColor(textStyle, context) || resolveColor(child(textStyle, 'fontRef'), context), bold: val(textStyle, 'b') === 'on' } : null,
      };
    }
    return parts;
  };
  const tableOf = (tbl, context, part) => {
    const properties = child(tbl, 'tblPr');
    const flag = (name) => ['1', 'true'].includes(val(properties, name));
    const parts = tableStyleParts(child(properties, 'tableStyleId')?.textContent?.trim(), context) || {};
    const columns = childrenNamed(child(tbl, 'tblGrid'), 'gridCol').map(column => emu(val(column, 'w'), 80));
    const rows = childrenNamed(tbl, 'tr');
    budget.cells(rows.length * Math.max(1, columns.length));
    const borderCss = (border) => border ? `${round(Math.max(0.75, border.width))}px solid ${colorCss({ ...border.color, a: 1 })}` : null;
    return {
      columns,
      rows: rows.map((row, rowIndex) => ({
        height: emu(val(row, 'h'), 20),
        cells: childrenNamed(row, 'tc').map((cell, columnIndex) => ({ cell, columnIndex })).filter(({ cell }) => val(cell, 'hMerge') !== '1' && val(cell, 'vMerge') !== '1' && !['1', 'true'].includes(val(cell, 'hMerge')) && !['1', 'true'].includes(val(cell, 'vMerge'))).map(({ cell, columnIndex }) => {
          const span = Math.max(1, Number(val(cell, 'gridSpan')) || 1);
          const rowSpan = Math.max(1, Number(val(cell, 'rowSpan')) || 1);
          const dataRow = rowIndex - (flag('firstRow') ? 1 : 0);
          const layers = [parts.wholeTbl, flag('bandRow') && dataRow >= 0 && dataRow % 2 === 0 ? parts.band1H : flag('bandRow') && dataRow >= 0 ? parts.band2H : null,
            flag('firstCol') && columnIndex === 0 ? parts.firstCol : null, flag('lastCol') && columnIndex + span >= columns.length ? parts.lastCol : null,
            flag('lastRow') && rowIndex === rows.length - 1 ? parts.lastRow : null, flag('firstRow') && rowIndex === 0 ? parts.firstRow : null].filter(Boolean);
          const layered = (read) => { for (const layer of [...layers].reverse()) { const value = read(layer); if (value !== undefined && value !== null) return value; } return null; };
          const cellProperties = child(cell, 'tcPr');
          const ownFill = fillOf(fillChild(cellProperties), context, part);
          const fill = ownFill === undefined ? layered(layer => layer.fill) : ownFill?.color || null;
          const css = {};
          if (fill) css['background-color'] = colorCss(fill);
          const outer = { left: columnIndex === 0, right: columnIndex + span >= columns.length, top: rowIndex === 0, bottom: rowIndex + rowSpan >= rows.length };
          for (const [side, own] of [['left', 'lnL'], ['right', 'lnR'], ['top', 'lnT'], ['bottom', 'lnB']]) {
            const line = child(cellProperties, own);
            let value = null;
            if (line) value = child(line, 'noFill') ? 'none' : borderCss({ color: resolveColor(child(line, 'solidFill'), context) || rgbOf('000000'), width: emu(val(line, 'w'), 1) });
            else {
              const style = layered(layer => layer.borders?.[outer[side] ? side : side === 'left' || side === 'right' ? 'insideV' : 'insideH']);
              if (style) value = borderCss(style);
            }
            if (value) css[`border-${side}`] = value;
          }
          const textStyle = { color: layered(layer => layer.text?.color), bold: layered(layer => layer.text?.bold || null) };
          const text = textOf(child(cell, 'txBody'), [], context, 'other', textStyle.color);
          if (text && textStyle.bold) for (const paragraph of text.paragraphs) for (const run of paragraph.runs) if (!run.css['font-weight']) run.css['font-weight'] = 'bold';
          const insets = ['marL', 'marT', 'marR', 'marB'].map((name, index) => emu(val(cellProperties, name), index % 2 ? 4.8 : 9.6));
          css.padding = insets.map((value, index) => px([insets[1], insets[2], insets[3], insets[0]][index])).join(' ');
          css['vertical-align'] = { ctr: 'middle', b: 'bottom' }[val(cellProperties, 'anchor')] || 'top';
          return { colSpan: span, rowSpan, css, text };
        }),
      })),
    };
  };

  // Shapes of a shape tree; transform maps child coordinates (groups) to the slide.
  const shapesOf = (tree, context, transform, depth = 0) => {
    const shapes = [];
    if (depth > MAX_GROUP_DEPTH) return shapes;
    for (let node of elements(tree)) {
      if (node.localName === 'AlternateContent') node = elements(child(node, 'Choice') || child(node, 'Fallback'))[0];
      if (!node) continue;
      const kind = node.localName;
      if (!['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp', 'contentPart'].includes(kind)) continue;
      budget.shape();
      const nonVisual = child(node, 'nvSpPr') || child(node, 'nvPicPr') || child(node, 'nvGraphicFramePr') || child(node, 'nvGrpSpPr') || child(node, 'nvCxnSpPr');
      if (['1', 'true'].includes(val(child(nonVisual, 'cNvPr'), 'hidden'))) {
        if (context.layer === 'slide') hidden.count += visibleText(node);
        continue;
      }
      const ph = descendant(child(nonVisual, 'nvPr'), 'ph');
      // Template placeholders are only drawn through the slide shapes that use them.
      if (ph && context.layer !== 'slide') continue;
      const type = ph ? val(ph, 'type') || 'obj' : null;
      const masterType = ph ? MASTER_TYPE[type] || 'body' : null;
      const layoutShape = ph ? (val(ph, 'idx') !== null && context.layout.placeholders.find(item => item.idx === val(ph, 'idx'))) || context.layout.placeholders.find(item => item.type === type) : null;
      const masterShape = ph ? context.master.placeholders.find(item => (MASTER_TYPE[item.type] || 'body') === masterType && (masterType !== 'body' || item.type === 'body' || item.type === 'obj')) ||
        context.master.placeholders.find(item => (MASTER_TYPE[item.type] || 'body') === masterType) : null;
      const chain = [masterShape?.node, layoutShape?.node, node].filter(Boolean);
      const shapeProperties = chain.map(item => child(item, 'spPr') || child(item, 'grpSpPr')).filter(Boolean);
      const xfrm = [...chain].reverse().map(item => child(child(item, 'spPr') || child(item, 'grpSpPr'), 'xfrm') || child(item, 'xfrm')).find(Boolean);
      const offset = child(xfrm, 'off');
      const extent = child(xfrm, 'ext');
      const box = transform({ x: emu(val(offset, 'x')), y: emu(val(offset, 'y')), w: emu(val(extent, 'cx')), h: emu(val(extent, 'cy')) });
      const shape = { ...box, rotation: (Number(val(xfrm, 'rot')) || 0) / 60000, flipH: val(xfrm, 'flipH') === '1', flipV: val(xfrm, 'flipV') === '1', template: context.layer !== 'slide' };
      if (kind === 'grpSp') {
        const childOffset = child(xfrm, 'chOff');
        const childExtent = child(xfrm, 'chExt');
        const scaleX = emu(val(childExtent, 'cx')) ? box.w / emu(val(childExtent, 'cx')) : 1;
        const scaleY = emu(val(childExtent, 'cy')) ? box.h / emu(val(childExtent, 'cy')) : 1;
        const inner = (item) => ({ x: box.x + (item.x - emu(val(childOffset, 'x'))) * scaleX, y: box.y + (item.y - emu(val(childOffset, 'y'))) * scaleY, w: item.w * scaleX, h: item.h * scaleY });
        shapes.push(...shapesOf(node, context, inner, depth + 1));
        continue;
      }
      if (kind === 'contentPart') { limitations.add('unsupported-embedded-object', 'drawing'); continue; }
      if (kind === 'pic') {
        const picture = pictureOf(child(node, 'blipFill'), context.part);
        if ([...nonVisual.getElementsByTagNameNS('*', 'videoFile'), ...nonVisual.getElementsByTagNameNS('*', 'audioFile'), ...nonVisual.getElementsByTagNameNS('*', 'media')].length) limitations.add('unsupported-embedded-object', 'media');
        shapes.push({ ...shape, ...(picture.src ? { picture } : { missing: picture.missing }) });
        continue;
      }
      if (kind === 'graphicFrame') {
        const data = descendant(node, 'graphicData');
        const uri = val(data, 'uri') || '';
        const table = child(data, 'tbl');
        if (table) { shapes.push({ ...shape, table: tableOf(table, context, context.part) }); continue; }
        const object = /chart/i.test(uri) ? 'chart' : /diagram/i.test(uri) ? 'diagram' : 'object';
        limitations.add('unsupported-embedded-object', object);
        shapes.push({ ...shape, missing: `[${object === 'chart' ? 'Chart' : object === 'diagram' ? 'SmartArt diagram' : 'Embedded object'} not shown]` });
        continue;
      }
      const style = child(node, 'style');
      const ownFill = [...shapeProperties].reverse().map(properties => fillOf(fillChild(properties), context, context.part)).find(fill => fill !== undefined);
      const referenceColor = (name) => Number(val(child(style, name), 'idx')) > 0 ? resolveColor(child(style, name), context) : null;
      const fill = ownFill !== undefined ? ownFill : referenceColor('fillRef') ? { color: referenceColor('fillRef') } : null;
      const lineNode = [...shapeProperties].reverse().map(properties => child(properties, 'ln')).find(Boolean);
      let line = null;
      if (!child(lineNode, 'noFill')) {
        const color = resolveColor(child(lineNode, 'solidFill'), context) || referenceColor('lnRef');
        if (color) line = { color, width: Math.max(0.75, emu(val(lineNode, 'w'), Number(val(child(style, 'lnRef'), 'idx')) || 1)), dash: !!child(lineNode, 'prstDash') && !['solid'].includes(val(child(lineNode, 'prstDash'))) };
      }
      const preset = [...shapeProperties].reverse().map(properties => val(child(properties, 'prstGeom'), 'prst')).find(Boolean) || (shapeProperties.some(properties => child(properties, 'custGeom')) ? 'custom' : 'rect');
      if (kind === 'cxnSp' || ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3'].includes(preset)) {
        if (line) shapes.push({ ...shape, connector: true, line });
        continue;
      }
      const kindOfText = !ph ? 'other' : masterType === 'title' ? 'title' : masterType === 'body' ? 'body' : 'other';
      const fontColor = resolveColor(child(style, 'fontRef'), context);
      const text = textOf(child(node, 'txBody'), [masterShape?.node, layoutShape?.node].filter(Boolean).map(item => child(item, 'txBody')).filter(Boolean), context, kindOfText, fontColor);
      const geometry = POLYGONS[preset] ? preset : RECTANGLES.has(preset) || preset === 'custom' || preset.startsWith('flowChart') ? preset : 'rect';
      if ((preset === 'custom' || !RECTANGLES.has(geometry) && !POLYGONS[geometry]) && !text && (fill || line)) limitations.add('unsupported-embedded-object', 'drawing');
      if (!text && !fill && !line) continue;
      shapes.push({ ...shape, geometry: preset === 'custom' ? 'rect' : geometry, fill: preset === 'custom' && !text ? null : fill, line: preset === 'custom' && !text ? null : line, text, title: masterType === 'title' });
    }
    return shapes;
  };

  const backgroundOf = (docs, context) => {
    for (const { doc, part } of docs) {
      const background = descendant(child(doc?.documentElement, 'cSld'), 'bg');
      if (!background) continue;
      const properties = child(background, 'bgPr');
      if (properties) return fillOf(fillChild(properties), context, part) || null;
      const reference = child(background, 'bgRef');
      if (reference) {
        const color = resolveColor(reference, context);
        const index = Number(val(reference, 'idx'));
        const styleList = descendant(context.themeDoc, index >= 1001 ? 'bgFillStyleLst' : 'fillStyleLst');
        const styled = elements(styleList)[index >= 1001 ? index - 1001 : index - 1];
        return (styled && fillOf(styled, { ...context, placeholderColor: color }, part)) || (color ? { color } : null);
      }
    }
    return null;
  };

  const slides = [];
  const visible = [];
  for (const [index, path] of slidePaths.entries()) {
    signal?.throwIfAborted();
    const doc = pkg.parse(path);
    if (!doc) continue;
    if (['0', 'false'].includes(val(doc.documentElement, 'show'))) { hidden.count += visibleText(child(doc.documentElement, 'cSld')); continue; }
    visible.push({ index, path, doc });
  }
  if (visible.length > MAX_SLIDES) throw pageLimit(`${label} exceeds the 60 page limit.`);
  for (const { index, path, doc } of visible) {
    signal?.throwIfAborted();
    const layoutPath = pkg.relatedByType(path, '/slideLayout')[0]?.path;
    const masterPath = layoutPath ? pkg.relatedByType(layoutPath, '/slideMaster')[0]?.path : null;
    const layout = layoutPath ? template(layoutPath) : { doc: null, placeholders: [] };
    const master = masterPath ? template(masterPath) : { doc: null, placeholders: [] };
    const theme = themeOf(masterPath || '');
    const map = { ...colorMap(descendant(master.doc, 'clrMap')), ...colorMap(descendant(child(layout.doc?.documentElement, 'clrMapOvr'), 'overrideClrMapping')), ...colorMap(descendant(child(doc.documentElement, 'clrMapOvr'), 'overrideClrMapping')) };
    const base = { colors: theme.colors, fonts: theme.fonts, themeDoc: theme.doc, map, txStyles: descendant(master.doc, 'txStyles'), layout, master };
    const identity = (box) => box;
    const shapes = [];
    // Master and layout decorations (logos, bars) are drawn unless the slide or layout hides them.
    if (val(doc.documentElement, 'showMasterSp') !== '0') {
      if (val(layout.doc?.documentElement, 'showMasterSp') !== '0' && master.doc) shapes.push(...shapesOf(descendant(master.doc, 'spTree'), { ...base, part: masterPath, layer: 'master' }, identity));
      if (layout.doc) shapes.push(...shapesOf(descendant(layout.doc, 'spTree'), { ...base, part: layoutPath, layer: 'layout' }, identity));
    }
    shapes.push(...shapesOf(descendant(doc, 'spTree'), { ...base, part: path, layer: 'slide' }, identity));
    const background = backgroundOf([{ doc, part: path }, { doc: layout.doc, part: layoutPath }, { doc: master.doc, part: masterPath }], base);
    // Speaker notes: the notes placeholder text, not drawn on the slide.
    const notesPath = pkg.relatedByType(path, '/notesSlide')[0]?.path;
    const notesDoc = notesPath ? pkg.parse(notesPath) : null;
    const notes = [...notesDoc?.getElementsByTagNameNS('*', 'sp') || []].filter(shape => val(descendant(shape, 'ph'), 'type') === 'body')
      .map(shape => childrenNamed(descendant(shape, 'txBody'), 'p').map(paragraph => [...paragraph.getElementsByTagNameNS('*', 't')].map(text => text.textContent).join('')).join('\n').trim())
      .filter(Boolean).join('\n');
    budget.text(notes.length);
    slides.push({ number: index + 1, background, shapes, notes });
  }
  return { label, width, height, slides, hidden, limitations };
};

// ---- ODP ----
const transformOf = (value) => {
  const rotate = /rotate\s*\(\s*(-?[\d.]+)\s*\)/.exec(value || '');
  const translate = /translate\s*\(\s*(-?[\d.]+(?:cm|mm|in|pt|pc|px))\s+(-?[\d.]+(?:cm|mm|in|pt|pc|px))\s*\)/.exec(value || '');
  return { angle: rotate ? Number(rotate[1]) : 0, x: translate ? toPx(translate[1]) : null, y: translate ? toPx(translate[2]) : null };
};
export const readOdpPresentation = ({ content, styles, entries, signal, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels, maxText = Infinity }) => {
  const label = 'ODP';
  const presentation = content.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'presentation')[0];
  if (!presentation) throw new Error('Invalid ODP XML.');
  const styleSheet = createOdfStyles(content, styles);
  const budget = createBudget(label, maxText);
  const limitations = createLimitations();
  const hidden = { count: 0 };
  const imageSource = createImageSources({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels });
  const children = (node) => node ? [...node.childNodes].filter(item => item.nodeType === Node.ELEMENT_NODE) : [];
  const namedFill = (localName, name) => [...styles?.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', localName) || []].find(item => odfAttr(item, 'draw', 'name') === name) || null;
  const fillOfProperties = (properties, shapeDefault) => {
    const kind = properties['draw:fill'] ?? (shapeDefault ? 'solid' : 'none');
    if (kind === 'solid' && isColor(properties['draw:fill-color']) && properties['draw:fill-color'] !== 'transparent') return { color: rgbOf(properties['draw:fill-color'].slice(1)) };
    if (kind === 'gradient') {
      const gradient = namedFill('gradient', properties['draw:fill-gradient-name']);
      const start = odfAttr(gradient, 'draw', 'start-color');
      const end = odfAttr(gradient, 'draw', 'end-color');
      if (isColor(start) && isColor(end) && start !== 'transparent' && end !== 'transparent') {
        const angle = (Number(odfAttr(gradient, 'draw', 'angle')) || 0) / 10;
        const middle = rgbOf(start.slice(1));
        const last = rgbOf(end.slice(1));
        return { color: { r: (middle.r + last.r) / 2, g: (middle.g + last.g) / 2, b: (middle.b + last.b) / 2, a: 1 }, css: `linear-gradient(${round(180 - angle)}deg, ${start}, ${end})` };
      }
    }
    if (kind === 'bitmap') {
      const image = namedFill('fill-image', properties['draw:fill-image-name']);
      const source = image ? imageSource((odfAttr(image, 'xlink', 'href') || '').replace(/^\.\//, '')) : null;
      if (source?.src) return { image: source.src };
      if (source?.limitation) limitations.add(source.limitation, source.format);
    }
    return null;
  };
  const graphicOf = (node) => {
    const presentationStyle = odfAttr(node, 'presentation', 'style-name');
    return presentationStyle ? styleSheet.resolve('presentation', presentationStyle) : styleSheet.resolve('graphic', odfAttr(node, 'draw', 'style-name'));
  };
  const paragraphCss = (properties = {}) => {
    const css = {};
    const align = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'justify' }[properties['fo:text-align']];
    if (align) css['text-align'] = align;
    if (isLength(properties['fo:margin-left'])) css['padding-left'] = px(Math.max(0, toPx(properties['fo:margin-left'])));
    if (isLength(properties['fo:text-indent'])) css['text-indent'] = properties['fo:text-indent'];
    if (isLength(properties['fo:margin-top'])) css['margin-top'] = properties['fo:margin-top'];
    if (isLength(properties['fo:margin-bottom'])) css['margin-bottom'] = properties['fo:margin-bottom'];
    if (/^\d+(?:\.\d+)?%$/.test(properties['fo:line-height'] || '')) css['line-height'] = String(round(1.2 * parseFloat(properties['fo:line-height']) / 100));
    return css;
  };
  const textOf = (container, graphic, title) => {
    const paragraphs = [];
    const counters = [];
    const levelStyleOf = (listStyle, level) => children(listStyle).find(item => Number(odfAttr(item, 'text', 'level')) === level) || null;
    const add = (paragraph, level, listStyle, numbered) => {
      const resolved = styleSheet.resolve('paragraph', odfAttr(paragraph, 'text', 'style-name'));
      const baseCss = { 'font-size': '18pt', ...odfTextCss(graphic.text, styleSheet.fonts), ...odfTextCss(resolved.text, styleSheet.fonts) };
      const runs = odfRuns(paragraph, styleSheet, baseCss).filter(run => run.text);
      budget.text(runs.reduce((sum, run) => sum + run.text.length, 0));
      const css = { ...paragraphCss(graphic.paragraph), ...paragraphCss(resolved.paragraph) };
      let bullet = null;
      const levelStyle = numbered ? levelStyleOf(listStyle, level) : null;
      if (levelStyle && runs.some(run => run.text.trim())) {
        const properties = children(levelStyle).find(item => odfIs(item, 'style', 'list-level-properties'));
        const alignment = children(properties).find(item => odfIs(item, 'style', 'list-level-label-alignment'));
        const start = alignment ? toPx(odfAttr(alignment, 'fo', 'margin-left'), level * 24) : toPx(odfAttr(properties, 'text', 'space-before'), (level - 1) * 24) + toPx(odfAttr(properties, 'text', 'min-label-width'), 24);
        const labelWidth = alignment ? Math.max(0, -toPx(odfAttr(alignment, 'fo', 'text-indent'), -24)) : toPx(odfAttr(properties, 'text', 'min-label-width'), 24);
        css['padding-left'] = px(Math.max(0, start));
        css['text-indent'] = px(-labelWidth);
        const bulletCss = { ...baseCss, ...odfTextCss(styleSheet.resolve('text', odfAttr(levelStyle, 'text', 'style-name')).text, styleSheet.fonts), ...odfTextCss(attributesOfChild(levelStyle, 'text-properties'), styleSheet.fonts) };
        if (odfIs(levelStyle, 'text', 'list-level-style-number')) {
          counters.length = level + 1;
          counters[level] = counters[level] === undefined ? Number(odfAttr(levelStyle, 'text', 'start-value')) || 1 : counters[level] + 1;
          const format = odfAttr(levelStyle, 'style', 'num-format') || '';
          bullet = format ? { text: `${odfAttr(levelStyle, 'style', 'num-prefix') || ''}${formatNumber(counters[level], format)}${odfAttr(levelStyle, 'style', 'num-suffix') || ''}` } : null;
        } else bullet = { text: [...(odfAttr(levelStyle, 'text', 'bullet-char') || '•')][0] || '•' };
        if (bullet) Object.assign(bullet, { css: { color: bulletCss.color, 'font-size': bulletCss['font-size'], 'font-weight': 'normal' }, width: labelWidth });
      }
      paragraphs.push({ css, bullet, runs, size: baseCss['font-size'], level });
    };
    const visit = (node, level, listStyle) => {
      for (const item of children(node)) {
        if (odfIs(item, 'text', 'p', 'h')) add(item, level, listStyle, level > 0 && !odfIs(node, 'text', 'list-header'));
        else if (odfIs(item, 'text', 'list')) {
          const own = odfAttr(item, 'text', 'style-name');
          visit(item, level + 1, (own && styleSheet.lists.get(own)) || listStyle || graphic.listStyle);
        } else if (odfIs(item, 'text', 'list-item', 'list-header')) visit(item, level, listStyle);
      }
    };
    visit(container, 0, null);
    if (!paragraphs.some(paragraph => paragraph.runs.some(run => run.text.trim()))) return null;
    const vertical = graphic.graphic['draw:textarea-vertical-align'];
    return {
      paragraphs, title, wrap: graphic.graphic['fo:wrap-option'] !== 'no-wrap',
      anchor: vertical === 'middle' ? 'middle' : vertical === 'bottom' ? 'bottom' : 'top',
      insets: Object.fromEntries(['left', 'top', 'right', 'bottom'].map(side => [side, toPx(graphic.graphic[`fo:padding-${side}`], toPx(graphic.graphic['fo:padding'], side === 'left' || side === 'right' ? 9.4 : 4.7))])),
    };
  };
  const attributesOfChild = (node, name) => {
    const element = children(node).find(item => odfIs(item, 'style', name));
    const result = {};
    for (const attribute of element?.attributes || []) {
      const prefix = { 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo', 'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style' }[attribute.namespaceURI];
      if (prefix) result[`${prefix}:${attribute.localName}`] = attribute.value;
    }
    return result;
  };
  const objectKind = (href) => {
    const data = entries[`${(href || '').replace(/^\.\//, '').replace(/\/$/, '')}/content.xml`];
    return data && /<chart:chart[\s>]/.test(new TextDecoder().decode(data.subarray(0, 65536))) ? 'chart' : 'object';
  };
  const tableOf = (table) => {
    const columns = [];
    const visitColumns = (node) => {
      for (const item of children(node)) {
        if (odfIs(item, 'table', 'table-column')) {
          const repeat = Math.min(256 - columns.length, Math.max(1, Number(odfAttr(item, 'table', 'number-columns-repeated')) || 1));
          const width = toPx(styleSheet.resolve('table-column', odfAttr(item, 'table', 'style-name')).column['style:column-width'], 100);
          for (let index = 0; index < repeat; index++) columns.push(width);
        } else if (odfIs(item, 'table', 'table-columns', 'table-header-columns', 'table-column-group')) visitColumns(item);
      }
    };
    visitColumns(table);
    const rows = [];
    const visitRows = (node) => {
      for (const item of children(node)) {
        if (odfIs(item, 'table', 'table-rows', 'table-header-rows', 'table-row-group')) visitRows(item);
        else if (odfIs(item, 'table', 'table-row')) rows.push(item);
      }
    };
    visitRows(table);
    budget.cells(rows.length * Math.max(1, columns.length));
    return {
      columns,
      rows: rows.slice(0, 500).map(row => ({
        height: toPx(styleSheet.resolve('table-row', odfAttr(row, 'table', 'style-name')).row['style:row-height'], 20),
        cells: children(row).filter(cell => odfIs(cell, 'table', 'table-cell')).slice(0, 256).map((cell) => {
          const resolved = styleSheet.resolve('table-cell', odfAttr(cell, 'table', 'style-name'));
          const css = {};
          for (const side of ['', '-top', '-bottom', '-left', '-right']) if (BORDER.test(resolved.cell[`fo:border${side}`] || '')) css[`border${side}`] = resolved.cell[`fo:border${side}`];
          if (!Object.keys(css).length) css.border = '0.75pt solid #808080';
          const fill = fillOfProperties(resolved.graphic, false) || (isColor(resolved.cell['fo:background-color']) && resolved.cell['fo:background-color'] !== 'transparent' ? { color: rgbOf(resolved.cell['fo:background-color'].slice(1)) } : null);
          if (fill?.color) css['background-color'] = colorCss(fill.color);
          css.padding = '0.1cm 0.25cm';
          css['vertical-align'] = { middle: 'middle', bottom: 'bottom' }[resolved.cell['style:vertical-align']] || 'top';
          return {
            colSpan: Math.min(256, Math.max(1, Number(odfAttr(cell, 'table', 'number-columns-spanned')) || 1)), rowSpan: Math.min(500, Math.max(1, Number(odfAttr(cell, 'table', 'number-rows-spanned')) || 1)),
            css, text: textOf(cell, { text: resolved.text, paragraph: resolved.paragraph, graphic: {}, listStyle: null }, false),
          };
        }),
      })),
    };
  };
  const SHAPES = ['frame', 'custom-shape', 'rect', 'ellipse', 'circle', 'g', 'line', 'connector', 'polygon', 'polyline', 'path', 'caption', 'measure', 'regular-polygon'];
  const shapesOf = (parent, layer, depth = 0) => {
    const shapes = [];
    if (depth > MAX_GROUP_DEPTH) return shapes;
    for (const node of children(parent)) {
      if (!odfIs(node, 'draw', ...SHAPES)) continue;
      budget.shape();
      const presentationClass = odfAttr(node, 'presentation', 'class');
      if (odfAttr(node, 'presentation', 'placeholder') === 'true') continue;
      if (layer === 'master' && presentationClass) continue;
      if (odfIs(node, 'draw', 'g')) { shapes.push(...shapesOf(node, layer, depth + 1)); continue; }
      const graphic = graphicOf(node);
      const transform = transformOf(odfAttr(node, 'draw', 'transform'));
      const box = {
        x: transform.x ?? toPx(odfAttr(node, 'svg', 'x')), y: transform.y ?? toPx(odfAttr(node, 'svg', 'y')),
        w: toPx(odfAttr(node, 'svg', 'width')), h: toPx(odfAttr(node, 'svg', 'height')),
      };
      const shape = { ...box, rotation: -transform.angle * 180 / Math.PI, origin: transform.x !== null ? 'top left' : 'center', template: layer !== 'slide' };
      const lineOf = () => {
        const kind = graphic.graphic['draw:stroke'] ?? (odfIs(node, 'draw', 'frame') ? 'none' : 'solid');
        const color = graphic.graphic['svg:stroke-color'];
        return kind !== 'none' && isColor(color) && color !== 'transparent' ? { color: rgbOf(color.slice(1)), width: Math.max(0.75, toPx(graphic.graphic['svg:stroke-width'], 1)), dash: kind === 'dash' } : null;
      };
      if (odfIs(node, 'draw', 'line', 'connector')) {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(name => toPx(odfAttr(node, 'svg', name)));
        const line = lineOf() || { color: rgbOf('000000'), width: 1 };
        shapes.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), flipH: x2 < x1, flipV: y2 < y1, rotation: 0, connector: true, line, template: layer !== 'slide' });
        continue;
      }
      if (odfIs(node, 'draw', 'frame')) {
        const parts = children(node);
        const textBox = parts.find(item => odfIs(item, 'draw', 'text-box'));
        const table = parts.find(item => odfIs(item, 'table', 'table'));
        const object = parts.find(item => odfIs(item, 'draw', 'object', 'object-ole', 'plugin'));
        const images = parts.filter(item => odfIs(item, 'draw', 'image'));
        if (table) { shapes.push({ ...shape, table: tableOf(table) }); continue; }
        if (object) {
          const kind = odfIs(object, 'draw', 'plugin') ? 'media' : objectKind(odfAttr(object, 'xlink', 'href'));
          limitations.add('unsupported-embedded-object', kind);
          shapes.push({ ...shape, missing: `[${kind === 'chart' ? 'Chart' : kind === 'media' ? 'Media' : 'Embedded object'} not shown]` });
          continue;
        }
        if (images.length && !textBox) {
          const sources = images.map(image => imageSource((odfAttr(image, 'xlink', 'href') || '').replace(/^\.\//, '')));
          const source = sources.find(item => item.src) || sources[0];
          if (source.src) shapes.push({ ...shape, picture: { src: source.src, crop: { l: 0, t: 0, r: 0, b: 0 } } });
          else { limitations.add(source.limitation, source.format); shapes.push({ ...shape, missing: `[Image not shown: ${source.format.toUpperCase()}]` }); }
          continue;
        }
        const text = textBox ? textOf(textBox, graphic, presentationClass === 'title') : null;
        const fill = fillOfProperties(graphic.graphic, false);
        const line = lineOf();
        if (text || fill || line) shapes.push({ ...shape, geometry: 'rect', fill, line, text, title: presentationClass === 'title' });
        continue;
      }
      const shapeType = odfAttr(children(node).find(item => odfIs(item, 'draw', 'enhanced-geometry')), 'draw', 'type') || (odfIs(node, 'draw', 'ellipse', 'circle') ? 'ellipse' : 'rectangle');
      const geometry = ODP_SHAPES[shapeType] || 'rect';
      const text = textOf(node, { ...graphic, graphic: { 'draw:textarea-vertical-align': 'middle', ...graphic.graphic } }, false);
      if (!ODP_SHAPES[shapeType] && !text) limitations.add('unsupported-embedded-object', 'drawing');
      const fill = fillOfProperties(graphic.graphic, true);
      const line = lineOf();
      if (!text && !fill && !line) continue;
      shapes.push({ ...shape, geometry, fill, line, text });
    }
    return shapes;
  };
  const textCount = (node) => [...node.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'p')].filter(paragraph => paragraph.textContent.trim()).length;
  const pages = children(presentation).filter(node => odfIs(node, 'draw', 'page'));
  const visible = [];
  for (const [index, page] of pages.entries()) {
    const properties = styleSheet.resolve('drawing-page', odfAttr(page, 'draw', 'style-name')).page;
    if (properties['presentation:visibility'] === 'hidden' || odfAttr(page, 'presentation', 'visibility') === 'hidden') {
      hidden.count += children(page).filter(node => !odfIs(node, 'presentation', 'notes')).reduce((sum, node) => sum + textCount(node), 0);
      continue;
    }
    visible.push({ index, page, properties });
  }
  if (visible.length > MAX_SLIDES) throw pageLimit(`${label} exceeds the 60 page limit.`);
  let width = toPx('28cm');
  let height = toPx('15.75cm');
  const slides = [];
  for (const { index, page, properties } of visible) {
    signal?.throwIfAborted();
    const master = styleSheet.masters.get(odfAttr(page, 'draw', 'master-page-name')) || styleSheet.masters.values().next().value || null;
    const pageLayout = styleSheet.pageLayouts.get(odfAttr(master, 'style', 'page-layout-name'));
    const layoutProperties = attributesOfChild(pageLayout, 'page-layout-properties');
    if (isLength(layoutProperties['fo:page-width']) && isLength(layoutProperties['fo:page-height'])) {
      width = Math.min(8000, Math.max(50, toPx(layoutProperties['fo:page-width'])));
      height = Math.min(8000, Math.max(50, toPx(layoutProperties['fo:page-height'])));
    }
    const masterProperties = styleSheet.resolve('drawing-page', odfAttr(master, 'draw', 'style-name')).page;
    const background = properties['draw:fill'] && properties['draw:fill'] !== 'none' ? fillOfProperties(properties, false) : properties['draw:fill'] === 'none' ? null : fillOfProperties(masterProperties, false);
    const shapes = [...(master ? shapesOf(master, 'master') : []), ...shapesOf(page, 'slide')];
    const notes = children(children(page).find(node => odfIs(node, 'presentation', 'notes')))
      .filter(node => odfIs(node, 'draw', 'frame') && odfAttr(node, 'presentation', 'class') === 'notes')
      .map(frame => [...frame.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'p')].map(paragraph => paragraph.textContent).join('\n').trim())
      .filter(Boolean).join('\n');
    budget.text(notes.length);
    slides.push({ number: index + 1, background, shapes, notes, size: { width, height } });
  }
  return { label, width, height, slides, hidden, limitations };
};

// ---- Text ----
const readingOrder = (slide) => slide.shapes.filter(shape => !shape.template && (shape.text || shape.table))
  .map((shape, index) => ({ shape, index }))
  .sort((a, b) => (b.shape.title ? 1 : 0) - (a.shape.title ? 1 : 0) || Math.round(a.shape.y / 8) - Math.round(b.shape.y / 8) || a.shape.x - b.shape.x || a.index - b.index)
  .map(item => item.shape);
const textLines = (text, invisible, counter) => {
  if (!text) return [];
  return text.paragraphs.map((paragraph) => {
    let value = '';
    for (const run of paragraph.runs) {
      if (invisible?.has(run)) { if (run.text.trim()) counter.count++; continue; }
      value += run.text;
    }
    return value.trim() ? `${paragraph.bullet ? `${paragraph.bullet.text} ` : ''}${value}` : '';
  }).filter(Boolean);
};
const slideText = (slide, invisible, counter) => {
  if (!slide.number) return [];
  const lines = [`[Slide ${slide.number}]`];
  for (const shape of readingOrder(slide)) {
    if (shape.text) lines.push(...textLines(shape.text, invisible, counter));
    else for (const row of shape.table.rows) {
      const cells = row.cells.map(cell => textLines(cell.text, invisible, counter).join(' / '));
      if (cells.some(Boolean)) lines.push(cells.join('\t'));
    }
  }
  if (slide.notes) lines.push(`[Speaker notes]\n${slide.notes}`);
  return lines;
};
// Per page: "[Slide N]" (its number in the file), the title, then text top to bottom and left to right; tables as tab-separated rows.
export const presentationPageTexts = (presentation, pages) => {
  const counter = { count: 0 };
  const pageTexts = pages.map(page => page.sources.flatMap(source => slideText(source.slide, pages.invisibleSources, counter)));
  return { pageTexts, invisibleCount: counter.count };
};
export const presentationText = (presentation) => presentation.slides.map(slide => slideText(slide, null, { count: 0 }).join('\n')).join('\n\n');

// ---- Rendering ----
// The mean colour of a picture, used as the background behind text drawn over it:
// otherwise white text on a dark photo would count as white on white.
const averageColor = (image) => {
  const canvas = document.createElement('canvas');
  try {
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 16, 16);
    context.drawImage(image, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    const sum = [0, 0, 0];
    for (let index = 0; index < pixels.length; index += 4) for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[index + channel];
    return colorCss({ r: sum[0] / 256, g: sum[1] / 256, b: sum[2] / 256, a: 1 });
  } catch { return null; } finally { canvas.width = canvas.height = 0; }
};
// A background colour that is never painted (clipped to the glyphs, under opaque text) but
// tells the invisible-text check what the text is drawn on.
const contrastBackground = (element, color) => {
  if (color) applyCss(element, { 'background-color': color, 'background-clip': 'text', '-webkit-background-clip': 'text' });
};
const renderSlidePages = async ({ presentation, signal, encodePageImage, maxImageCharacters, pageImages, redact }) => {
  const { label } = presentation;
  const sourceOf = new WeakMap();
  const pendingImages = [];
  const loadImage = (src, onLoad) => {
    const image = html('img');
    image.src = src;
    pendingImages.push(imageLoaded(image).then(() => onLoad?.(image)));
    return image;
  };
  const paragraphsInto = (target, text) => {
    for (const paragraph of text.paragraphs) {
      const element = applyCss(html('p'), { 'white-space': text.wrap ? 'pre-wrap' : 'pre', ...paragraph.css, 'font-size': paragraph.size || '18pt' });
      if (paragraph.bullet) {
        const bullet = applyCss(html('span'), { ...paragraph.bullet.css, display: 'inline-block', 'min-width': px(paragraph.bullet.width || 0), 'text-indent': '0', 'font-style': 'normal', 'text-decoration-line': 'none' });
        bullet.textContent = paragraph.bullet.width ? paragraph.bullet.text : `${paragraph.bullet.text} `;
        element.append(bullet);
      }
      for (const run of paragraph.runs) {
        if (run.text === '\n') { element.append(html('br')); continue; }
        const span = applyCss(html('span'), run.css);
        span.append(mappedText(run.text, run, sourceOf));
        element.append(span);
      }
      target.append(element);
    }
  };
  const textArea = (text) => {
    const area = applyCss(html('div'), {
      position: 'absolute', inset: '0', display: 'flex', 'flex-direction': 'column', 'box-sizing': 'border-box', overflow: 'visible',
      'justify-content': text.anchor === 'middle' ? 'center' : text.anchor === 'bottom' ? 'flex-end' : 'flex-start',
      padding: [text.insets.top, text.insets.right, text.insets.bottom, text.insets.left].map(px).join(' '), 'line-height': '1.2',
    });
    paragraphsInto(area, text);
    return area;
  };
  const tableElement = (table) => {
    const element = applyCss(html('table'), { width: '100%', 'table-layout': 'fixed', 'border-collapse': 'collapse', 'line-height': '1.2' });
    element.dataset.visual = 'table';
    const columns = html('colgroup');
    for (const width of table.columns) columns.append(applyCss(html('col'), { width: px(width) }));
    element.append(columns);
    const body = html('tbody');
    for (const row of table.rows) {
      const tr = applyCss(html('tr'), { height: px(row.height) });
      for (const cell of row.cells) {
        const td = applyCss(html('td'), cell.css);
        td.colSpan = cell.colSpan;
        td.rowSpan = cell.rowSpan;
        if (cell.text) paragraphsInto(td, { ...cell.text, wrap: true });
        tr.append(td);
      }
      body.append(tr);
    }
    element.append(body);
    return element;
  };
  const drawShape = (shape, canvas, underlay) => {
    const transforms = [];
    if (shape.rotation) transforms.push(`rotate(${round(shape.rotation)}deg)`);
    if (shape.flipH && !shape.text && !shape.connector) transforms.push('scaleX(-1)');
    if (shape.flipV && !shape.text && !shape.connector) transforms.push('scaleY(-1)');
    const box = applyCss(html('div'), {
      position: 'absolute', left: px(shape.x), top: px(shape.y), width: px(Math.max(0, shape.w)), height: px(Math.max(0, shape.h)), 'box-sizing': 'border-box',
      ...(transforms.length ? { transform: transforms.join(' '), 'transform-origin': shape.origin === 'top left' ? '0 0' : '50% 50%' } : {}),
    });
    if (shape.connector) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of [['width', '100%'], ['height', '100%'], ['viewBox', '0 0 100 100'], ['preserveAspectRatio', 'none']]) svg.setAttribute(name, value);
      applyCss(svg, { position: 'absolute', inset: '0', overflow: 'visible' });
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const [x1, x2] = shape.flipH ? [100, 0] : [0, 100];
      const [y1, y2] = shape.flipV ? [100, 0] : [0, 100];
      for (const [name, value] of [['x1', x1], ['y1', y1], ['x2', x2], ['y2', y2], ['stroke', colorCss(shape.line.color)], ['stroke-width', round(shape.line.width)], ['vector-effect', 'non-scaling-stroke']]) line.setAttribute(name, value);
      if (shape.line.dash) line.setAttribute('stroke-dasharray', '6 4');
      svg.append(line);
      box.append(svg);
      canvas.append(box);
      return;
    }
    if (shape.picture) {
      box.dataset.visual = 'picture';
      box.style.overflow = 'hidden';
      const { crop } = shape.picture;
      const visibleWidth = Math.max(0.05, 1 - crop.l - crop.r);
      const visibleHeight = Math.max(0.05, 1 - crop.t - crop.b);
      const image = loadImage(shape.picture.src, (loaded) => { shape.averageColor = averageColor(loaded); for (const callback of shape.onAverage || []) callback(shape.averageColor); });
      applyCss(image, { position: 'absolute', 'max-width': 'none', width: `${round(100 / visibleWidth)}%`, height: `${round(100 / visibleHeight)}%`, left: `${round(-crop.l / visibleWidth * 100)}%`, top: `${round(-crop.t / visibleHeight * 100)}%` });
      box.append(image);
      canvas.append(box);
      return;
    }
    if (shape.missing) {
      box.append(placeholder(shape.missing, '100%', '100%'));
      canvas.append(box);
      return;
    }
    if (shape.table) {
      box.append(tableElement(shape.table));
      canvas.append(box);
      return;
    }
    const polygon = POLYGONS[shape.geometry];
    const fillCss = shape.fill?.color ? colorCss(shape.fill.color) : null;
    if (polygon && (shape.fill || shape.line)) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of [['width', '100%'], ['height', '100%'], ['viewBox', '0 0 100 100'], ['preserveAspectRatio', 'none']]) svg.setAttribute(name, value);
      applyCss(svg, { position: 'absolute', inset: '0', overflow: 'visible' });
      const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      outline.setAttribute('points', polygon.map(([x, y]) => `${x * 100},${y * 100}`).join(' '));
      outline.setAttribute('fill', fillCss || 'none');
      if (shape.line) for (const [name, value] of [['stroke', colorCss(shape.line.color)], ['stroke-width', round(shape.line.width)], ['vector-effect', 'non-scaling-stroke']]) outline.setAttribute(name, value);
      svg.append(outline);
      box.append(svg);
    } else {
      if (shape.fill?.image) {
        box.dataset.visual = 'picture';
        box.append(applyCss(loadImage(shape.fill.image, (loaded) => contrastBackground(box.lastElementChild?.tagName === 'DIV' ? box.lastElementChild : box, averageColor(loaded))), { position: 'absolute', inset: '0', width: '100%', height: '100%', 'max-width': 'none' }));
      } else if (shape.fill?.color) applyCss(box, { 'background-color': fillCss, ...(shape.fill.css ? { 'background-image': shape.fill.css } : {}) });
      if (shape.line) box.style.border = `${px(shape.line.width)} ${shape.line.dash ? 'dashed' : 'solid'} ${colorCss({ ...shape.line.color, a: shape.line.color.a })}`;
      if (shape.geometry === 'ellipse') box.style.borderRadius = '50%';
      else if (shape.geometry === 'roundRect') box.style.borderRadius = px(Math.min(shape.w, shape.h) * 0.1667);
    }
    if (shape.text) {
      const area = textArea(shape.text);
      if (polygon && fillCss) contrastBackground(area, fillCss);
      // Text without its own fill, over a picture: its contrast is checked against the picture.
      if (!shape.fill && underlay) (underlay.onAverage ||= []).push(color => contrastBackground(area, color));
      box.append(area);
    }
    canvas.append(box);
  };
  const pieces = [];
  const styles = new Map();
  for (const slide of presentation.slides) {
    signal?.throwIfAborted();
    const size = slide.size || presentation;
    const canvas = applyCss(html('div'), { position: 'relative', width: px(size.width), height: px(size.height), overflow: 'hidden' });
    const background = slide.background;
    const backgroundColor = background?.color ? colorCss({ ...background.color, a: 1 }) : '#ffffff';
    if (backgroundColor !== '#ffffff' || background?.css || background?.image) canvas.dataset.visual = 'background';
    if (background?.css) applyCss(canvas, { 'background-image': background.css });
    const style = { slide, width: size.width, height: size.height, background: backgroundColor };
    if (background?.image) {
      canvas.append(applyCss(loadImage(background.image, (loaded) => { style.average = averageColor(loaded); }), { position: 'absolute', inset: '0', width: '100%', height: '100%', 'max-width': 'none' }));
    }
    slide.shapes.forEach((shape, index) => {
      // The topmost picture under the centre of a text shape.
      const centre = { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
      const underlay = shape.text ? slide.shapes.slice(0, index).reverse().find(item => item.picture && centre.x >= item.x && centre.x <= item.x + item.w && centre.y >= item.y && centre.y <= item.y + item.h) : null;
      drawShape(shape, canvas, underlay);
    });
    const name = `slide:${slide.number}`;
    styles.set(name, style);
    pieces.push({ element: canvas, source: { slide }, master: name, before: true });
  }
  const createPage = (style) => {
    const root = applyCss(html('div', 'doc-page'), {
      width: px(style.width), height: px(style.height), padding: '0', 'background-color': style.average || style.background,
      'font-family': "'Calibri', 'Carlito', 'Liberation Sans', sans-serif", 'font-size': '18pt', 'line-height': '1.2',
    });
    const page = { root, body: applyCss(html('div', 'doc-body'), { margin: '0', padding: '0' }), notes: html('div', 'doc-notes') };
    root.append(page.body, page.notes);
    return page;
  };
  const first = styles.values().next().value || { slide: null, width: presentation.width, height: presentation.height, background: '#ffffff' };
  if (!pieces.length) pieces.push({ element: applyCss(html('div'), { width: px(presentation.width), height: px(presentation.height) }), source: { slide: { number: 0, shapes: [], notes: '' } } });
  const pages = await paginateAndRender({
    pieces, useSoftBreaks: false, label, signal, encodePageImage, maxImageCharacters, pendingImages, sourceOf, pageImages, redact,
    firstStyle: first, styleByName: (name) => styles.get(name) || null, nextStyle: (style) => style, createPage,
  });
  return { pages, imageLimitations: presentation.limitations.list(), invisibleSources: pages.invisibleSources };
};

export const renderPptxPages = (options) => renderSlidePages(options);
export const renderOdpPages = (options) => renderSlidePages(options);
