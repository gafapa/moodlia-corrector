// Shared page engine for word-processor documents (ODT and DOCX). A format
// module converts its XML into HTML "pieces" (blocks, table rows, list items);
// this engine places them on pages and rasterizes each page, so documents reach
// the model like PDFs: each page's text beside an image of that page.
// Only data: images built from the file's own bytes are loaded, and every style
// value is validated before it becomes CSS.

export const MAX_PAGES = 60;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_CANVAS_EDGE = 16384;

export const LENGTH = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:cm|mm|in|pt|pc|px|em)$/;
export const PERCENT = /^(?:\d+(?:\.\d+)?|\.\d+)%$/;
export const COLOR = /^#[0-9a-f]{6}$/i;
export const BORDER = /^(?:none|hidden|(?:\d+(?:\.\d+)?|\.\d+)(?:pt|cm|mm|in|px)\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\s+#[0-9a-f]{6})$/i;
export const FONT_FAMILY = /^[\p{L}\p{N} '",._-]{1,200}$/u;
const PX_PER_UNIT = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1, em: 16 };
export const toPx = (value, fallback = 0) => {
  const match = LENGTH.test(value || '') && value.match(/^(-?[\d.]+)([a-z]+)$/);
  return match ? Number(match[1]) * PX_PER_UNIT[match[2]] : fallback;
};
export const isLength = (value) => LENGTH.test(value || '');
export const isLengthOrPercent = (value) => LENGTH.test(value || '') || PERCENT.test(value || '');
export const isColor = (value) => COLOR.test(value || '') || value === 'transparent';
export const applyCss = (element, css) => {
  for (const [property, value] of Object.entries(css)) element.style.setProperty(property, value);
  return element;
};
export const html = (tag, className) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
};
// HTMLImageElement.decode() waits for animation frames, which never run in an
// offscreen document; the load event does not.
export const imageLoaded = (image) => image.complete && image.naturalWidth ? Promise.resolve() : new Promise((resolve, reject) => {
  image.addEventListener('load', resolve, { once: true });
  image.addEventListener('error', () => reject(new Error('Image could not be loaded.')), { once: true });
});
// Format modules map each drawn text node to the XML node it came from, so text
// that turns out invisible on the page can be left out of the extracted text.
// Clones (repeated table headers and cells) keep the mapping of their original.
export const cloneMapped = (element, sourceOf) => {
  const copy = element.cloneNode(true);
  if (!sourceOf) return copy;
  const originals = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const copies = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let original = originals.nextNode(), cloned = copies.nextNode(); original && cloned; original = originals.nextNode(), cloned = copies.nextNode()) {
    if (sourceOf.has(original)) sourceOf.set(cloned, sourceOf.get(original));
  }
  return copy;
};
export const mappedText = (text, source, sourceOf) => {
  const node = document.createTextNode(text);
  sourceOf?.set(node, source);
  return node;
};
export const placeholder = (label, width, height) => {
  const box = applyCss(html('span', 'doc-placeholder'), { ...(width ? { width } : {}), ...(height ? { 'min-height': height } : {}) });
  box.textContent = label;
  return box;
};

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
// Formats are ODF codes (1, a, A, i, I) or their Word names.
export const formatNumber = (value, format) => {
  const code = { lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I', decimalZero: '01' }[format] || format;
  if ((code === 'a' || code === 'A') && value > 0) {
    let text = '';
    for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) text = String.fromCharCode(97 + (rest - 1) % 26) + text;
    return code === 'A' ? text.toUpperCase() : text;
  }
  if ((code === 'i' || code === 'I') && value > 0 && value < 4000) {
    let text = '';
    let rest = value;
    for (const [amount, numeral] of ROMAN) while (rest >= amount) { text += numeral; rest -= amount; }
    return code === 'I' ? text.toUpperCase() : text;
  }
  if (code === '01') return String(value).padStart(2, '0');
  return String(value);
};

// Counts content that could not be drawn, reported in the receipt as omittedImages.
export const createLimitations = () => {
  const counts = new Map();
  return {
    add: (reason, format) => counts.set(`${reason}:${format}`, (counts.get(`${reason}:${format}`) || 0) + 1),
    list: () => [...counts].map(([key, count]) => {
      const [reason, format] = key.split(':');
      return { reason, format, count };
    }),
  };
};

// Resolves an archive image to a data: URL, or to the reason it cannot be drawn.
export const createImageSources = ({ entries, sniffFormat, bitmapDimensions, bytesToBase64, maxPixels }) => {
  const cache = new Map();
  return (name, inlineData = null) => {
    if (!inlineData && cache.has(name)) return cache.get(name);
    // Linked images live outside the file; they are reported, never fetched.
    if (!inlineData && /^(?:[a-z][a-z0-9+.-]*:|\/|\.\.\/)/i.test(name)) return { format: 'link', limitation: 'external-linked-image' };
    const data = inlineData || entries[name];
    const result = { format: (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'unknown').toLowerCase() };
    if (data?.length) {
      const sniffed = sniffFormat(data);
      const head = new TextDecoder().decode(data.subarray(0, 512)).trimStart();
      const mimeType = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[sniffed] ||
        (sniffed === 'bitmap' ? (data[0] === 0x42 ? 'image/bmp' : 'image/gif') : '') ||
        (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head) ? 'image/svg+xml' : '');
      const dimensions = sniffed === 'png' && data.length >= 24
        ? { width: new DataView(data.buffer, data.byteOffset).getUint32(16), height: new DataView(data.buffer, data.byteOffset).getUint32(20) }
        : sniffed === 'bitmap' ? bitmapDimensions(data) : null;
      if (mimeType && dimensions && (dimensions.width > 16384 || dimensions.height > 16384 || dimensions.width * dimensions.height > maxPixels)) result.limitation = 'embedded-image-size-limit';
      else if (mimeType) result.src = `data:${mimeType};base64,${bytesToBase64(data)}`;
    }
    if (!result.src && !result.limitation) result.limitation = 'unsupported-embedded-image-format';
    if (!inlineData) cache.set(name, result);
    return result;
  };
};

export const STYLE_SHEET = `
.doc-page{box-sizing:border-box;position:relative;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#000;font-family:'Liberation Serif','Times New Roman',serif;font-size:12pt;line-height:1.15;text-align:left}
.doc-page p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.doc-page p:empty::before{content:"\\200b"}
.doc-page table{border-collapse:collapse;border-spacing:0}
.doc-page td{vertical-align:top;padding:0}
.doc-page img{display:block;max-width:100%}
.doc-page sup{font-size:58%;line-height:0}
.doc-body{flex:1 1 auto;min-height:0;overflow:hidden;margin:0 -4px;padding:0 4px}
.doc-header,.doc-footer{flex:none}
.doc-notes{flex:none;font-size:10pt}
.doc-notes:not(:empty){border-top:0.5pt solid #000;margin-top:0.2cm;padding-top:0.1cm}
.doc-placeholder{display:inline-block;box-sizing:border-box;border:1px dashed #777;color:#555;font:10pt sans-serif;padding:2px 4px;text-align:left;text-indent:0;white-space:normal}
`;

// Text a reader of the page image could not see: a colour too close to its
// background, a size under about 2.6 pt, glyphs squeezed together, or text
// outside the page or a clipping box. A student could otherwise hide
// instructions for the model in the extracted text.
const MIN_CONTRAST = 1.25;
const MIN_FONT_PX = 3.5;
const channel = (value) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const parseColor = (value) => {
  const parts = /^rgba?\(([^)]+)\)$/.exec(value || '')?.[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return parts && parts.length >= 3 && parts.every(Number.isFinite) ? { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 } : null;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const findInvisibleText = (root) => {
  const styles = new Map();
  const style = (element) => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element));
    return styles.get(element);
  };
  const backgrounds = new Map();
  const background = (element) => {
    if (backgrounds.has(element)) return backgrounds.get(element);
    const own = parseColor(style(element).backgroundColor);
    const result = own && own.a >= 0.5 ? own : element === root || !element.parentElement ? { r: 255, g: 255, b: 255, a: 1 } : background(element.parentElement);
    backgrounds.set(element, result);
    return result;
  };
  const clips = new Map();
  const clip = (element) => {
    if (clips.has(element)) return clips.get(element);
    const parent = element === root || !element.parentElement ? null : clip(element.parentElement);
    let result = parent;
    if (element === root || style(element).overflow !== 'visible') {
      const box = element.getBoundingClientRect();
      const own = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      result = parent ? { left: Math.max(own.left, parent.left), top: Math.max(own.top, parent.top), right: Math.min(own.right, parent.right), bottom: Math.min(own.bottom, parent.bottom) } : own;
    }
    clips.set(element, result);
    return result;
  };
  // A picture drawn after the text (a positioned image or shape, as on slides) can
  // cover it; text with at least 60% of each line under one picture is hidden.
  const pictures = [...root.querySelectorAll('img, svg, canvas')].filter(picture => !picture.closest('math') &&
    !(parseInt(style(picture).zIndex, 10) < 0) && !(parseInt(style(picture.parentElement).zIndex, 10) < 0))
    .map(picture => ({ picture, box: picture.getBoundingClientRect() })).filter(({ box }) => box.width >= 4 && box.height >= 4);
  const coveredByPicture = (node, rects) => pictures.length > 0 && rects.length > 0 && pictures.some(({ picture, box }) =>
    node.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING && !picture.contains(node) && [...rects].every((rect) => {
      const overlap = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left)) * Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
      return overlap >= 0.6 * rect.width * rect.height;
    }));
  const invisible = new Set();
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const characters = node.data.replace(/[\s​]/g, '').length;
    if (!characters || node.parentElement?.closest('style')) continue;
    const element = node.parentElement;
    const computed = style(element);
    const color = parseColor(computed.color);
    const back = background(element);
    let hidden = parseFloat(computed.fontSize) < MIN_FONT_PX || (color && (color.a < 0.1 ||
      (Math.max(luminance(color), luminance(back)) + 0.05) / (Math.min(luminance(color), luminance(back)) + 0.05) < MIN_CONTRAST));
    if (!hidden) {
      range.selectNodeContents(node);
      const area = clip(element);
      let width = 0;
      let visible = false;
      for (const rect of range.getClientRects()) {
        width += rect.width;
        if (Math.min(rect.right, area.right) - Math.max(rect.left, area.left) >= 1 && Math.min(rect.bottom, area.bottom) - Math.max(rect.top, area.top) >= 1) visible = true;
      }
      hidden = !visible || width / characters < 1 || coveredByPicture(node, range.getClientRects());
    }
    if (hidden) invisible.add(node);
  }
  range.detach?.();
  return invisible;
};

// A page needs its image when it shows more than text: images, formulas, tables,
// drawings, placeholders, borders, shading or highlighting, or struck-through text.
// Headers and footers are left out: a logo there would otherwise mark every page.
const hasVisualContent = (page) => [page.body, page.notes].some(area => area && (
  area.querySelector('img, svg, math, table, .doc-placeholder, [data-visual]') ||
  [...area.querySelectorAll('*')].some(element => {
    const computed = getComputedStyle(element);
    return (parseColor(computed.backgroundColor)?.a || 0) > 0 ||
      ['Top', 'Right', 'Bottom', 'Left'].some(side => computed[`border${side}Style`] !== 'none' && parseFloat(computed[`border${side}Width`]) > 0) ||
      computed.textDecorationLine.includes('line-through');
  })));

// Pieces: { element (node or nodes), group ({ create() -> { element, target } }) for
// table rows and list items, notes (footnote elements), source (XML node),
// before/after (forced page breaks), softBreak/softBefore/softAfter (saved
// page breaks), master (page style that starts a new page), styleChange
// (page style for the following pages, without a break), orphans/widows (lines kept
// together when a paragraph is split, default 2), trimTop (drop the spacing above
// when the piece is moved to the top of a new page), overhang (an anchored
// object that may hang into the bottom margin) }. A group can also be a column
// box (multi-column sections); its paragraphs move whole between pages.
// pageImages 'visual' rasterizes only pages with visual content (hasVisualContent);
// text-only pages then have image null. The result also carries
// invisibleSources: the XML nodes (through sourceOf) of text found invisible.
export const MAX_PAGE_PARTS = 4;
export const paginateAndRender = async ({
  pieces, useSoftBreaks, firstStyle, styleByName, nextStyle, createPage, label,
  signal, encodePageImage, maxImageCharacters, pendingImages = [], sourceOf = null, pageImages = 'all', redact = null,
}) => {
  // Decode before measuring pages; an image without a declared height takes its own.
  // The wait is bounded in case an image never reports load or error.
  await Promise.all(pendingImages.map(promise => Promise.race([promise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))])));
  signal?.throwIfAborted();
  const host = applyCss(document.createElement('div'), { position: 'absolute', left: '-100000px', top: '0', visibility: 'hidden', 'pointer-events': 'none' });
  const style = document.createElement('style');
  style.textContent = STYLE_SHEET;
  host.append(style);
  document.body.append(host);
  const pages = [];
  try {
    const newPage = (pageStyle) => {
      if (pages.length >= MAX_PAGES) throw Object.assign(new Error(`${label} exceeds the 60 page limit.`), { code: 'PAGE_LIMIT' });
      const page = { ...createPage(pageStyle), style: pageStyle, sources: [], lastGroup: null, lastTarget: null };
      applyCss(page.root, { 'margin-bottom': '20px' });
      host.append(page.root);
      page.afterAttach?.();
      pages.push(page);
      return page;
    };
    const overflows = (page) => page.body.scrollHeight > page.body.clientHeight + 1;
    // A paragraph that does not fit is split at the last line that does, keeping at least
    // piece.orphans lines before and piece.widows lines after the break (default two each,
    // Word's and Writer's widow and orphan control; one when the document turns it off).
    // Returns the continuation paragraph, FITS when the paragraph fits once its spacing
    // below is dropped, or null when it cannot be split.
    const splitParagraph = (page, paragraph, { orphans = 2, widows = 2 } = {}) => {
      const limit = page.body.getBoundingClientRect().top + page.body.clientHeight;
      const range = document.createRange();
      const lines = [];
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let offset = 0; offset < node.data.length; offset++) {
          if (/\s/.test(node.data[offset])) continue;
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          const line = lines.at(-1);
          if (!line || rect.top >= line.bottom - 1) lines.push({ node, offset, bottom: rect.bottom });
          else line.bottom = Math.max(line.bottom, rect.bottom);
        }
      }
      let first = lines.findIndex(line => line.bottom > limit);
      // A floating picture or text box that does not fit moves to the next page with its paragraph.
      if ([...paragraph.querySelectorAll('[data-anchored="float"]')].some(element => element.getBoundingClientRect().bottom > limit + 1)) return null;
      // Every line fits and only the spacing below overflows: the spacing is dropped at the page end.
      if (first < 0) {
        const spacing = { padding: paragraph.style.paddingBottom, margin: paragraph.style.marginBottom };
        applyCss(paragraph, { 'padding-bottom': '0', 'margin-bottom': '0' });
        if (!overflows(page)) return FITS;
        applyCss(paragraph, { 'padding-bottom': spacing.padding, 'margin-bottom': spacing.margin });
        return null;
      }
      first = Math.min(first, lines.length - Math.max(1, widows));
      if (first < Math.max(1, orphans)) return null;
      const { node, offset } = lines[first];
      range.setStart(node, offset);
      range.setEnd(paragraph, paragraph.childNodes.length);
      const rest = range.extractContents();
      // The text node cut in two keeps its source in both parts.
      const cut = document.createTreeWalker(rest, NodeFilter.SHOW_TEXT).nextNode();
      if (cut && sourceOf?.has(node) && !sourceOf.has(cut)) sourceOf.set(cut, sourceOf.get(node));
      const continuation = paragraph.cloneNode(false);
      continuation.append(rest);
      applyCss(continuation, { 'text-indent': '0', 'padding-top': '0', 'margin-top': '0' });
      // The first part's last line is not the paragraph's last line, so justified text stays justified.
      applyCss(paragraph, { 'padding-bottom': '0', 'margin-bottom': '0', ...(getComputedStyle(paragraph).textAlign === 'justify' ? { 'text-align-last': 'justify' } : {}) });
      return continuation;
    };
    const FITS = {};
    const splittable = (piece) => !piece.group && piece.element instanceof HTMLParagraphElement;
    const place = (page, piece) => {
      let created = null;
      let target = page.body;
      if (piece.group) {
        if (page.lastGroup !== piece.group) {
          created = piece.group.create();
          // A table continued (or moved) onto a new page drops its spacing above there.
          if (piece.trimTop && startedGroups.has(piece.group)) created.element.style.marginTop = '0';
          startedGroups.add(piece.group);
          page.body.append(created.element);
          page.lastGroup = piece.group;
          page.lastTarget = created.target;
        }
        target = page.lastTarget;
      } else page.lastGroup = page.lastTarget = null;
      const elements = Array.isArray(piece.element) ? piece.element : [piece.element];
      target.append(...elements);
      page.notes.append(...(piece.notes || []));
      page.sources.push(piece.source);
      return () => {
        for (const element of [...elements, ...(piece.notes || [])]) element.remove();
        if (created) { created.element.remove(); page.lastGroup = page.lastTarget = null; }
        page.sources.pop();
      };
    };
    let startedGroups = new WeakSet();
    const paginate = (soft) => {
      for (const old of pages.splice(0)) old.root.remove();
      startedGroups = new WeakSet();
      let page = null;
      let pendingBreak = false;
      let followingStyle = null;
      // A page style change without a break applies from the next new page.
      const startPage = (pageStyle) => {
        page = newPage(pageStyle);
        followingStyle = null;
      };
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index];
        if (index % 50 === 0) signal?.throwIfAborted();
        const master = piece.master ? styleByName(piece.master) : null;
        if (piece.styleChange) followingStyle = styleByName(piece.styleChange) || followingStyle;
        const forced = piece.before || master || soft && (piece.softBreak || piece.softBefore) || pendingBreak;
        if (!page) startPage(master || followingStyle || firstStyle);
        else if (forced && page.sources.length) startPage(master || followingStyle || nextStyle(page.style));
        pendingBreak = false;
        const undo = place(page, piece);
        // An anchored object allowed to leave the text area (overhang) may hang into the
        // bottom margin, as Writer places it: it starts in the text area and is moved up
        // just enough to end inside the page.
        const objects = !soft && piece.overhang && page.sources.length > 1 && overflows(page) ? [...piece.element.querySelectorAll('[data-overhang]')] : [];
        const bodyTop = page.body.getBoundingClientRect().top;
        const pageBottom = page.root.getBoundingClientRect().bottom - 1;
        if (objects.length && objects.every(object => { const box = object.getBoundingClientRect(); return box.top < bodyTop + page.body.clientHeight && box.height <= pageBottom - bodyTop; })) {
          for (const object of objects) {
            const excess = object.getBoundingClientRect().bottom - pageBottom;
            if (excess > 0) applyCss(object, { position: 'relative', top: `${-Math.ceil(excess)}px` });
          }
          applyCss(page.body, { overflow: 'visible' });
          page.overhang = true;
          pendingBreak = true;
          continue;
        }
        if (!soft && overflows(page)) {
          let continuation = splittable(piece) ? splitParagraph(page, piece.element, piece) : null;
          if (!continuation && page.sources.length > 1) {
            undo();
            startPage(followingStyle || nextStyle(page.style));
            // Word drops the spacing above a paragraph that a natural page break moved to the top of a page.
            if (piece.trimTop && piece.element instanceof HTMLElement) piece.element.style.paddingTop = '0';
            place(page, piece);
            // A paragraph taller than a whole page continues on the following pages.
            if (overflows(page) && splittable(piece)) continuation = splitParagraph(page, piece.element, piece);
          }
          // The continuation starts the next page; the paragraph's notes stay with its first part.
          if (continuation && continuation !== FITS) pieces.splice(index + 1, 0, { element: continuation, source: piece.source, notes: [], before: true, after: piece.after, orphans: piece.orphans, widows: piece.widows });
        }
        if (piece.after || soft && piece.softAfter) pendingBreak = true;
      }
      if (!page) newPage(firstStyle);
    };
    paginate(useSoftBreaks);
    // Saved breaks can be stale or partial (a document edited elsewhere): when a saved
    // page holds half a page more than fits, the whole document is measured instead.
    if (useSoftBreaks && pages.some(current => current.body.scrollHeight > current.body.clientHeight * 1.5)) paginate(false);
    signal?.throwIfAborted();

    const rendered = [];
    const invisibleSources = new Set();
    let imageCharacters = 0;
    for (const [index, current] of pages.entries()) {
      signal?.throwIfAborted();
      for (const field of current.root.querySelectorAll('[data-page-field]')) {
        field.textContent = String(field.dataset.pageField === 'page-number' ? index + 1 : pages.length);
      }
      // Content taller than its page (a long table row or paragraph) extends that page instead of being cut.
      const pageBox = current.root.getBoundingClientRect();
      if (overflows(current) && !current.overhang) {
        applyCss(current.root, { 'min-height': current.root.style.height, height: 'auto' });
        applyCss(current.body, { overflow: 'visible', flex: '1 0 auto' });
      }
      const invisible = findInvisibleText(current.root);
      const unmapped = (element) => element ? [...invisible].filter(node => element.contains(node)).length : 0;
      for (const node of invisible) if (sourceOf?.has(node)) invisibleSources.add(sourceOf.get(node));
      // Header and footer text as drawn on this page, with its page fields filled and invisible text left out.
      const drawnText = (element) => element ? [...element.querySelectorAll('p')].map((paragraph) => {
        const parts = [];
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!invisible.has(node)) parts.push(node.data);
        return parts.join('').replace(/\u200b/g, '');
      }).join('\n') : '';
      const page = {
        pageNumber: index + 1, sources: current.sources, header: current.headerSource, footer: current.footerSource,
        headerText: drawnText(current.header), footerText: drawnText(current.footer),
        headerInvisible: unmapped(current.header), footerInvisible: unmapped(current.footer),
        visual: hasVisualContent(current), images: [], image: null, redactions: 0,
      };
      rendered.push(page);
      if (pageImages === 'visual' && !page.visual) continue;
      const box = current.root.getBoundingClientRect();
      const width = Math.ceil(box.width);
      const height = Math.ceil(box.height);
      // A page extended far beyond its size (thousands of notes, a huge table row) is
      // drawn as up to four parts, top to bottom, so each stays legible.
      const parts = Math.min(MAX_PAGE_PARTS, Math.max(1, Math.ceil(height / Math.max(1, pageBox.height) - 0.25)));
      const partHeight = Math.ceil(height / parts);
      // The same resolution as a rendered PDF page; an extended page keeps it until the pixel cap.
      const ratio = Math.min(1.5, 2400 / Math.max(width, Math.min(partHeight, width * Math.SQRT2)),
        Math.sqrt(MAX_CANVAS_PIXELS / (width * partHeight)), MAX_CANVAS_EDGE / Math.max(width, partHeight));
      const canvasWidth = Math.max(1, Math.round(width * ratio));
      const canvasHeight = Math.max(1, Math.round(partHeight * ratio));
      const clone = current.root.cloneNode(true);
      applyCss(clone, { margin: '0' });
      // Characters that XML 1.0 forbids would make the whole page image fail to load.
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const redactions = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(node.data)) node.data = node.data.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
        if (redact && (redact.lastIndex = 0, redact.test(node.data))) redactions.push(node);
      }
      // The student's name is covered with a black bar on the image; the text keeps its width.
      for (const node of redactions) {
        const parts = [];
        let last = 0;
        for (const match of node.data.matchAll(redact)) {
          const bar = applyCss(html('span'), { 'background-color': '#000', color: '#000' });
          bar.textContent = match[0];
          parts.push(node.data.slice(last, match.index), bar);
          last = match.index + match[0].length;
        }
        parts.push(node.data.slice(last));
        node.replaceWith(...parts.filter(part => part !== ''));
        page.redactions += parts.filter(part => typeof part !== 'string').length;
      }
      const inlineStyle = document.createElement('style');
      inlineStyle.textContent = STYLE_SHEET;
      clone.prepend(inlineStyle);
      const content = `<foreignObject x="0" y="0" width="${width}" height="${height}">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
      for (let part = 0; part < parts; part++) {
        const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 ${part * partHeight} ${width} ${partHeight}">${content}`;
        const image = new Image();
        const loaded = imageLoaded(image);
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
        await loaded;
        signal?.throwIfAborted();
        const canvas = document.createElement('canvas');
        try {
          canvas.width = canvasWidth;
          canvas.height = canvasHeight;
          const context2d = canvas.getContext('2d');
          context2d.fillStyle = '#fff';
          context2d.fillRect(0, 0, canvasWidth, canvasHeight);
          context2d.drawImage(image, 0, 0, canvasWidth, canvasHeight);
          const encoded = encodePageImage(canvas);
          signal?.throwIfAborted();
          imageCharacters += encoded.base64Data.length;
          if (imageCharacters > maxImageCharacters) {
            throw Object.assign(new Error(`${label} page images exceed the safe transfer size. Split the document or reduce its image resolution.`), { code: 'PAGE_LIMIT' });
          }
          page.images.push({ pageNumber: index + 1, ...(parts > 1 ? { part: part + 1, parts } : {}), ...encoded });
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      page.image = page.images[0];
    }
    return Object.assign(rendered, { invisibleSources });
  } finally {
    host.remove();
  }
};
