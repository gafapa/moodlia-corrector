import { getDocument, GlobalWorkerOptions } from '../../lib/pdf.mjs';
import { unzipSync, strFromU8 } from '../../lib/fflate.mjs';
import '../attachmentSupport.js';
import { renderOdtPages } from './odtLayout.js';
import { ommlToText, renderDocxPages } from './docxLayout.js';
import { readOdsWorkbook, readXlsxWorkbook, renderOdsPages, renderXlsxPages, workbookPageTexts, workbookText } from './sheetLayout.js';
import { presentationPageTexts, presentationText, readOdpPresentation, readPptxPresentation, renderOdpPages, renderPptxPages } from './slideLayout.js';

const unsupportedAttachment = (message) => Object.assign(new Error(message), { code: 'UNSUPPORTED_ATTACHMENT' });

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');
const { MAX_TEXT, MAX_IMAGES, MAX_EXPANDED_BYTES, bytesToBase64 } = MoodliaCorrectorAttachmentSupport;

// PNG keeps typed text sharp but is huge for scans and photos: a noisy 1191x1684
// page can exceed 4 MB of base64. Fall back to JPEG above the per-page target.
const PAGE_IMAGE_TARGET_CHARACTERS = 1_200_000;
const MAX_READER_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_IMAGE_CHARACTERS = 48 * 1024 * 1024;
// Above 400,000 characters a page usually holds a photo or scan; JPEG is used
// when it is under half the PNG size, which keeps typed text pages in PNG.
const PAGE_IMAGE_JPEG_CHECK_CHARACTERS = 400_000;
const encodePageImage = (canvas) => {
  let base64Data = canvas.toDataURL('image/png').split(',')[1];
  if (base64Data.length <= PAGE_IMAGE_JPEG_CHECK_CHARACTERS) return { mimeType: 'image/png', base64Data };
  const jpeg = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  if (base64Data.length <= PAGE_IMAGE_TARGET_CHARACTERS) {
    return jpeg.length < base64Data.length / 2 ? { mimeType: 'image/jpeg', base64Data: jpeg } : { mimeType: 'image/png', base64Data };
  }
  base64Data = jpeg;
  if (base64Data.length <= PAGE_IMAGE_TARGET_CHARACTERS) return { mimeType: 'image/jpeg', base64Data };
  for (const quality of [0.85, 0.7]) {
    base64Data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if (base64Data.length <= PAGE_IMAGE_TARGET_CHARACTERS) break;
  }
  return { mimeType: 'image/jpeg', base64Data };
};

const readPdf = async (bytes, signal, redact = null) => {
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true,
    standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
    cMapUrl: chrome.runtime.getURL('lib/cmaps/'), cMapPacked: true,
    wasmUrl: chrome.runtime.getURL('lib/wasm/'),
  });
  const cancel = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await task.promise;
    if (pdf.numPages > 60) throw new Error('PDF exceeds the 60 page limit.');
    const sections = [];
    const textPages = [];
    const images = [];
    let textLength = 0;
    let imageCharacters = 0;
    let redactions = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
      textLength += text.length;
      if (textLength > MAX_TEXT) throw new Error('PDF exceeds the text limit.');
      const pageSections = [];
      if (text) pageSections.push(`Page ${pageNumber}\n${text}`);
      // Render every page: operator heuristics are not a reliable visual-content boundary.
      {
        if (images.length >= MAX_IMAGES) throw new Error('PDF exceeds the safe image extraction limit.');
        const viewport = page.getViewport({ scale: 2 });
        const scale = Math.min(2, 2400 / Math.max(viewport.width / 2, viewport.height / 2));
        const sizedViewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(sizedViewport.width);
        canvas.height = Math.ceil(sizedViewport.height);
        // Print intent avoids animation frames, which do not run in an offscreen document.
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: sizedViewport, intent: 'print' }).promise;
        if (redact) {
          const context2d = canvas.getContext('2d');
          context2d.fillStyle = '#000';
          for (const item of content.items) {
            if (!item.str || !item.transform) continue;
            for (const match of item.str.matchAll(redact)) {
              const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
              const x = item.transform[4] + item.width * match.index / item.str.length;
              const [a, b, c, d, e, f] = sizedViewport.transform;
              const point = (px, py) => [a * px + c * py + e, b * px + d * py + f];
              const [left, top] = point(x, item.transform[5] + size * 0.9);
              const [right, bottom] = point(x + item.width * match[0].length / item.str.length, item.transform[5] - size * 0.25);
              context2d.fillRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right - left), Math.abs(bottom - top));
              redactions++;
            }
          }
        }
        const image = encodePageImage(canvas);
        canvas.width = canvas.height = 0;
        imageCharacters += image.base64Data.length;
        // Chrome rejects runtime messages over 64 MiB; fail clearly instead of losing pages.
        if (imageCharacters > MAX_PAGE_IMAGE_CHARACTERS) throw new Error('PDF page images exceed the safe transfer size. Split the PDF or reduce its scan resolution.');
        images.push({ pageNumber, ...image });
        pageSections.push(`Page ${pageNumber}: visual content attached as an image.`);
      }
      const pageText = `${sections.length ? '\n\n' : ''}${pageSections.join('\n\n')}`;
      const start = textPages.at(-1)?.end || 0;
      textPages.push({ pageNumber, start, end: start + pageText.length });
      sections.push(pageText);
      page.cleanup();
    }
    // textContent also holds page labels; extractedTextCharacters counts the PDF's own text layer.
    return { documentFormat: 'pdf', mimeType: 'application/pdf', pageCount: pdf.numPages, textContent: sections.join(''), textPages, images, extractedTextCharacters: textLength, ...(redactions ? { redactions } : {}) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await task.destroy();
  }
};

// Ollama and compatible vision APIs accept PNG, JPEG and WebP. GIF and BMP are
// converted locally; vector or TIFF images are reported as omitted instead of
// discarding the readable document around them.
const convertibleImage = /\.(gif|bmp)$/i;
const MAX_OFFICE_IMAGE_PIXELS = 16 * 1024 * 1024;
const officeBitmapDimensions = (data) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 10 && /^GIF8[79]a$/.test(String.fromCharCode(...data.subarray(0, 6)))) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    const headerSize = view.getUint32(14, true);
    if (headerSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
    if (headerSize >= 40) return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }
  return null;
};
const readOfficeImages = async (entries, signal) => {
  const images = [];
  const omitted = new Map();
  for (const [name, data] of entries) {
    signal?.throwIfAborted();
    if (!data.length) continue;
    // The bytes decide the image type; Office part names can be wrong.
    const sniffed = sniffFormat(data);
    const mimeType = imageMimeTypes[sniffed] || '';
    if (mimeType) {
      if (images.length >= MAX_IMAGES) throw new Error('Document exceeds the image limit.');
      images.push({ mimeType, base64Data: bytesToBase64(data) }); continue;
    }
    if ((sniffed === 'bitmap' || convertibleImage.test(name)) && typeof createImageBitmap === 'function') {
      if (images.length >= MAX_IMAGES) throw new Error('Document exceeds the image limit.');
      const dimensions = officeBitmapDimensions(data);
      if (dimensions && (dimensions.width > 16384 || dimensions.height > 16384 || dimensions.width * dimensions.height > MAX_OFFICE_IMAGE_PIXELS)) {
        const format = (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'unknown').toLowerCase();
        const key = `embedded-image-size-limit:${format}`;
        omitted.set(key, (omitted.get(key) || 0) + 1);
        continue;
      }
      let bitmap;
      let canvas;
      try {
        if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error('Invalid embedded image header.');
        bitmap = await createImageBitmap(new Blob([data]));
        signal?.throwIfAborted();
        canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        images.push({ mimeType: 'image/png', base64Data: canvas.toDataURL('image/png').split(',')[1] });
        continue;
      } catch {
        // Cancellation must not become an unsupported-image warning.
        signal?.throwIfAborted();
      } finally {
        bitmap?.close();
        if (canvas) canvas.width = canvas.height = 0;
      }
    }
    const format = (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'unknown').toLowerCase();
    const key = `unsupported-embedded-image-format:${format}`;
    omitted.set(key, (omitted.get(key) || 0) + 1);
  }
  signal?.throwIfAborted();
  const imageLimitations = [...omitted].map(([key, count]) => {
    const [reason, format] = key.split(':');
    return { reason, format, count };
  });
  return { images, imageLimitations };
};

// Word stores each text box twice (mc:Choice and its VML mc:Fallback copy), and
// text-box paragraphs are nested inside the anchoring paragraph. Each paragraph
// therefore reads only its own runs; nested paragraphs are listed on their own.
const isInsideFallback = (node) => {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent.localName === 'Fallback') return true;
  return false;
};
const wordChild = (node, name) => node ? [...node.childNodes].find(item => item.nodeType === Node.ELEMENT_NODE && item.localName === name) || null : null;
const wordValue = (node, name = 'val') => {
  for (const attribute of node?.attributes || []) if (attribute.localName === name) return attribute.value;
  return null;
};
const wordOn = (node) => !!node && !['0', 'false', 'off'].includes(wordValue(node) ?? 'true');
// A w:sym or similar code becomes text only when it is a printable character.
const printableCodePoint = (code) => Number.isInteger(code) && code >= 0x20 && code !== 0x7f && code <= 0x10ffff &&
  !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0xe000 && code <= 0xf8ff) ? String.fromCodePoint(code) : '';
// Hidden text (w:vanish) is not drawn on the page, so it is not sent as text
// either: the teacher could not see instructions hidden there.
const createDocxHiddenCheck = (stylesDoc) => {
  const styles = new Map();
  let defaultParagraph = null;
  for (const style of stylesDoc?.getElementsByTagNameNS('*', 'style') || []) {
    const vanish = wordChild(wordChild(style, 'rPr'), 'vanish');
    styles.set(wordValue(style, 'styleId'), { basedOn: wordValue(wordChild(style, 'basedOn')), vanish: vanish ? wordOn(vanish) : undefined });
    if (wordValue(style, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(wordValue(style, 'default'))) defaultParagraph ||= wordValue(style, 'styleId');
  }
  const styleHidden = (id, depth = 0) => {
    const style = styles.get(id);
    if (!style || depth > 20) return undefined;
    return style.vanish ?? styleHidden(style.basedOn, depth + 1);
  };
  return (run) => {
    const properties = wordChild(run, 'rPr');
    const direct = wordChild(properties, 'vanish');
    if (direct) return wordOn(direct);
    const character = styleHidden(wordValue(wordChild(properties, 'rStyle')));
    if (character !== undefined) return character;
    let paragraph = run.parentNode;
    while (paragraph && paragraph.localName !== 'p') paragraph = paragraph.parentNode;
    return styleHidden(wordValue(wordChild(wordChild(paragraph, 'pPr'), 'pStyle')) || defaultParagraph) === true;
  };
};
// Keep tabs, manual breaks and non-breaking hyphens, which matter for code, tables and poems.
// Equations become a linear [Formula: ...] instead of their run text without structure.
// FILENAME field results are left out: requests do not carry original file names.
// Text found invisible on the rendered page (invisible.nodes) is left out and counted.
const docxParagraphText = (paragraph, isHidden = () => false, hidden = { count: 0 }, invisible = { nodes: null, count: 0 }) => {
  let text = '';
  const fields = [];
  const suppressed = () => fields.some(field => field.phase === 'instruction' || field.suppress);
  const visit = (node) => {
    for (const item of node.childNodes) {
      if (item.nodeType !== Node.ELEMENT_NODE || ['p', 'Fallback', 'delText', 'instrText', 'moveFrom', 'del'].includes(item.localName)) continue;
      if (item.localName === 'fldChar') {
        const type = wordValue(item, 'fldCharType');
        if (type === 'begin') fields.push({ instruction: '', phase: 'instruction' });
        else if (type === 'separate' && fields.length) fields.at(-1).phase = 'result';
        else if (type === 'end') fields.pop();
        continue;
      }
      if (item.localName === 'r') {
        const instruction = wordChild(item, 'instrText');
        if (instruction && fields.at(-1)?.phase === 'instruction') {
          fields.at(-1).instruction += instruction.textContent;
          fields.at(-1).suppress = /^\s*FILENAME\b/i.test(fields.at(-1).instruction);
        }
        if (isHidden(item)) {
          if ([...item.childNodes].some(child => child.localName === 't' && child.textContent.trim())) hidden.count++;
          continue;
        }
      }
      if (item.localName === 'fldSimple' && /^\s*FILENAME\b/i.test(wordValue(item, 'instr') || '')) continue;
      if (item.localName === 'oMath') {
        if (suppressed()) continue;
        const formula = ommlToText(item).replace(/\s+/g, ' ').trim();
        if (formula) text += `[Formula: ${formula}]`;
        continue;
      }
      if (['t', 'tab', 'br', 'cr', 'noBreakHyphen', 'sym'].includes(item.localName) && suppressed()) continue;
      if (invisible.nodes?.has(item)) {
        if (item.localName === 'sym' || item.textContent.trim()) invisible.count++;
        continue;
      }
      if (item.localName === 't') text += item.textContent;
      else if (item.localName === 'tab' && item.parentNode?.localName === 'r') text += '\t';
      else if (item.localName === 'br' || item.localName === 'cr') text += '\n';
      else if (item.localName === 'noBreakHyphen') text += '-';
      else if (item.localName === 'sym') text += printableCodePoint(parseInt(wordValue(item, 'char') || '', 16));
      else visit(item);
    }
  };
  visit(paragraph);
  return text;
};
// Charts, SmartArt and embedded objects are not converted; report them instead of dropping them silently.
const countEmbeddedObjects = (names, patterns) => Object.entries(patterns).flatMap(([format, pattern]) => {
  const count = new Set(names.map(name => name.match(pattern)?.[1]).filter(Boolean)).size;
  return count ? [{ reason: 'unsupported-embedded-object', format, count }] : [];
});
const docxPartOrder = (name) => name === 'word/document.xml' ? 0 : /footnotes|endnotes/.test(name) ? 1 : 2;
const docxPartLabel = (name) => name === 'word/document.xml' ? '' : /footnotes/.test(name) ? 'Footnotes' : /endnotes/.test(name) ? 'Endnotes' : /header/.test(name) ? 'Header' : 'Footer';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const docxParagraphs = (doc) => [...doc.getElementsByTagNameNS('*', 'p')].filter(paragraph => !isInsideFallback(paragraph));
const hiddenTextLimitation = (hidden, format) => hidden.count ? [{ reason: 'hidden-text-excluded', format, count: hidden.count }] : [];
const invisibleTextLimitation = (count, format) => count ? [{ reason: 'invisible-text-excluded', format, count }] : [];
// Headers and footers repeat on page images; their drawn text is listed on the first page that shows each one.
const addHeadersAndFooters = (layout, pageTexts, invisible) => layout.pages.forEach((page, index) => {
  const previous = layout.pages[index - 1];
  for (const [key, label] of [['header', 'Header'], ['footer', 'Footer']]) {
    if (previous && previous[key] === page[key]) continue;
    invisible.count += page[`${key}Invisible`] || 0;
    if (page[`${key}Text`].trim()) pageTexts[index][key === 'header' ? 'unshift' : 'push'](`[${label}]\n${page[`${key}Text`]}`);
  }
});
// List and heading numbers are drawn on the page; the text carries them too.
const withListLabel = (layout, paragraph, text) => layout.listLabels?.has(paragraph) ? `${layout.listLabels.get(paragraph)} ${text}` : text;

// Page text like a PDF's: "Page N" sections, each followed by its image label.
// With pageImages 'visual', a page that shows only text has no image and says so.
const pageImageLabel = (page) => page.images.length > 1
  ? `Page ${page.pageNumber}: visual content attached as ${page.images.length} images, top to bottom.`
  : page.images.length ? `Page ${page.pageNumber}: visual content attached as an image.`
    : `Page ${page.pageNumber}: text only (no images, formulas, tables or drawings); no page image attached.`;
const pagedResult = (layout, pageTexts, format, mimeType, imageLimitations) => {
  const sections = [];
  const textPages = [];
  let textLength = 0;
  for (const [index, page] of layout.pages.entries()) {
    const text = pageTexts[index].join('\n');
    textLength += text.length;
    if (textLength > MAX_TEXT) throw new Error(`${format.toUpperCase()} exceeds the text or image limit.`);
    const pageSections = [];
    if (text.trim()) pageSections.push(`Page ${page.pageNumber}\n${text}`);
    pageSections.push(pageImageLabel(page));
    const pageText = `${sections.length ? '\n\n' : ''}${pageSections.join('\n\n')}`;
    const start = textPages.at(-1)?.end || 0;
    textPages.push({ pageNumber: page.pageNumber, start, end: start + pageText.length });
    sections.push(pageText);
  }
  const images = layout.pages.flatMap(page => page.images);
  if (images.length > MAX_IMAGES) throw new Error(`${format.toUpperCase()} exceeds the text or image limit.`);
  return {
    documentFormat: format, mimeType, pageCount: layout.pages.length, textContent: sections.join(''), textPages,
    images, imageLimitations, extractedTextCharacters: textLength,
    ...(layout.pages.some(page => page.redactions) ? { redactions: layout.pages.reduce((sum, page) => sum + (page.redactions || 0), 0) } : {}),
  };
};

const readDocx = async (bytes, signal, { pageImages, redact } = {}) => {
  let expandedBytes = 0;
  const names = [];
  const entries = unzipSync(bytes, { filter: (entry) => {
    names.push(entry.name);
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('DOCX exceeds the decompressed size limit.');
    return /^word\/[^/]+\.xml$/.test(entry.name) || /^word\/_rels\/[^/]+\.rels$/.test(entry.name) || /^word\/theme\/[^/]+\.xml$/.test(entry.name) ||
      entry.name.startsWith('word/media/');
  } });
  if (!entries['word/document.xml']) throw unsupportedAttachment('The file is not a Word document (missing word/document.xml).');
  let stylesDoc = entries['word/styles.xml'] ? new DOMParser().parseFromString(strFromU8(entries['word/styles.xml']), 'application/xml') : null;
  if (stylesDoc?.querySelector('parsererror')) stylesDoc = null;
  const isHidden = createDocxHiddenCheck(stylesDoc);
  const textParts = Object.keys(entries).filter(name => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(name));
  const parsedParts = new Map(stylesDoc ? [['word/styles.xml', stylesDoc]] : []);
  const texts = [];
  const hidden = { count: 0 };
  // ZIP order is arbitrary: body first, then notes, then repeated headers and footers.
  for (const name of textParts.sort((a, b) => docxPartOrder(a) - docxPartOrder(b) || a.localeCompare(b))) {
    signal?.throwIfAborted();
    const doc = new DOMParser().parseFromString(strFromU8(entries[name]), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid DOCX XML.');
    parsedParts.set(name, doc);
    const text = docxParagraphs(doc).map(paragraph => docxParagraphText(paragraph, isHidden, name === 'word/document.xml' ? hidden : { count: 0 })).join('\n');
    if (text.trim()) texts.push(docxPartLabel(name) ? `[${docxPartLabel(name)}]\n${text}` : text);
  }
  const flatText = texts.join('\n\n');
  if (flatText.length > MAX_TEXT) throw new Error('DOCX exceeds the text or image limit.');
  const embeddedObjects = () => countEmbeddedObjects(names, {
    chart: /^word\/charts\/(chart\d+)\.xml$/, diagram: /^word\/diagrams\/(data\d+)\.xml$/, object: /^word\/embeddings\/([^/]+)$/,
  });

  let layout = null;
  try {
    layout = await renderDocxPages({
      entries, parsedParts, signal, encodePageImage, sniffFormat, bitmapDimensions: officeBitmapDimensions, bytesToBase64,
      maxImageCharacters: MAX_PAGE_IMAGE_CHARACTERS, maxPixels: MAX_OFFICE_IMAGE_PIXELS, pageImages, redact,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'PAGE_LIMIT') throw error;
  }
  if (!layout) {
    // Without page images the document keeps its text and embedded images, and the receipt says so.
    const { images, imageLimitations } = await readOfficeImages(Object.entries(entries).filter(([name]) => name.startsWith('word/media/')), signal);
    if (images.length > MAX_IMAGES) throw new Error('DOCX exceeds the text or image limit.');
    imageLimitations.push(...embeddedObjects(), ...hiddenTextLimitation(hidden, 'docx'), { reason: 'page-rendering-failed', format: 'docx', count: 1 });
    return { documentFormat: 'docx', mimeType: DOCX_MIME_TYPE, textContent: flatText, images, imageLimitations };
  }

  // Each body paragraph belongs to the page of the block that holds it; anything unplaced stays with the previous page.
  const pageOf = new Map();
  layout.pages.forEach((page, index) => {
    for (const source of page.sources) {
      // A paragraph split across pages is listed on the page where it starts.
      if (source.localName === 'p' && !pageOf.has(source)) pageOf.set(source, index);
      for (const node of source.getElementsByTagNameNS('*', 'p')) if (!pageOf.has(node)) pageOf.set(node, index);
    }
  });
  // Footnotes are listed once, on the page of the paragraph that first cites them; endnotes after the last page's text.
  const notesById = (kind) => new Map([...parsedParts.get(`word/${kind}s.xml`)?.getElementsByTagNameNS('*', kind) || []].map(note => [wordValue(note, 'id'), note]));
  const footnotes = notesById('footnote');
  const endnoteNodes = notesById('endnote');
  const invisible = { nodes: layout.invisibleSources, count: 0 };
  const paragraphText = (paragraph) => withListLabel(layout, paragraph, docxParagraphText(paragraph, isHidden, { count: 0 }, invisible));
  const noteText = (note) => note ? docxParagraphs(note).map(paragraphText).join('\n').trim() : '';
  const references = (root, name) => [...root.getElementsByTagNameNS('*', name)].filter(reference => !isInsideFallback(reference)).map(reference => wordValue(reference, 'id'));
  const pageTexts = layout.pages.map(() => []);
  const pageNotes = layout.pages.map(() => []);
  const listed = new Set();
  let pageIndex = 0;
  for (const paragraph of docxParagraphs(parsedParts.get('word/document.xml'))) {
    pageIndex = Math.max(pageIndex, pageOf.get(paragraph) ?? pageIndex);
    pageTexts[pageIndex].push(paragraphText(paragraph));
    for (const id of references(paragraph, 'footnoteReference')) if (!listed.has(id) && listed.add(id)) pageNotes[pageIndex].push(noteText(footnotes.get(id)));
  }
  pageNotes.forEach((notes, index) => {
    if (notes.some(Boolean)) pageTexts[index].push(`[Footnotes]\n${notes.filter(Boolean).join('\n')}`);
  });
  const endnotes = [...new Set(references(parsedParts.get('word/document.xml'), 'endnoteReference'))].map(id => noteText(endnoteNodes.get(id))).filter(Boolean);
  if (endnotes.length) pageTexts.at(-1).push(`[Endnotes]\n${endnotes.join('\n')}`);
  addHeadersAndFooters(layout, pageTexts, invisible);
  return pagedResult(layout, pageTexts, 'docx', DOCX_MIME_TYPE,
    [...layout.imageLimitations, ...hiddenTextLimitation(hidden, 'docx'), ...invisibleTextLimitation(invisible.count, 'docx')]);
};

const ODT_MIME_TYPE = 'application/vnd.oasis.opendocument.text';
const readOdt = async (bytes, signal, { pageImages, redact } = {}) => {
  let expandedBytes = 0;
  const names = [];
  const entries = unzipSync(bytes, { filter: (entry) => {
    names.push(entry.name);
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('ODT exceeds the decompressed size limit.');
    return ['content.xml', 'styles.xml'].includes(entry.name) || entry.name.startsWith('Pictures/') || entry.name.startsWith('ObjectReplacements/') ||
      /^Object [^/]+\/content\.xml$/.test(entry.name);
  } });
  if (!entries['content.xml']) throw unsupportedAttachment('The file is not an OpenDocument text (missing content.xml).');
  const doc = new DOMParser().parseFromString(strFromU8(entries['content.xml']), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid ODT XML.');
  // Styles only shape the page images; a damaged styles.xml keeps default page styles.
  let stylesDoc = entries['styles.xml'] ? new DOMParser().parseFromString(strFromU8(entries['styles.xml']), 'application/xml') : null;
  if (stylesDoc?.querySelector('parsererror')) stylesDoc = null;
  const textNamespace = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const drawNamespace = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
  const styleNamespace = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
  let textLength = 0;
  const countText = (length) => {
    if (length > MAX_TEXT - textLength) throw new Error('ODT exceeds the text or image limit.');
    textLength += length;
  };
  // Comments (office:annotation) are reviewer text, and text:tracked-changes keeps
  // deleted text; neither is the student's current answer. svg:title/desc is alt text.
  const officeNamespace = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
  const svgNamespace = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
  const isExcluded = (node) => node.namespaceURI === officeNamespace && ['annotation', 'annotation-end'].includes(node.localName) ||
    node.namespaceURI === textNamespace && node.localName === 'tracked-changes' ||
    node.namespaceURI === svgNamespace && ['title', 'desc'].includes(node.localName);
  const isInsideExcluded = (node) => {
    for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent.nodeType === Node.ELEMENT_NODE && isExcluded(parent)) return true;
    return false;
  };
  // Hidden text (text:display="none") is not drawn on the page, so it is not sent as text either.
  const hiddenStyles = (() => {
    const styles = new Map();
    for (const style of [...stylesDoc?.getElementsByTagNameNS(styleNamespace, 'style') || [], ...doc.getElementsByTagNameNS(styleNamespace, 'style')]) {
      const properties = [...style.childNodes].find(node => node.localName === 'text-properties');
      const display = properties?.getAttributeNS(textNamespace, 'display');
      styles.set(style.getAttributeNS(styleNamespace, 'name'), { parent: style.getAttributeNS(styleNamespace, 'parent-style-name'), hidden: display ? display === 'none' : undefined });
    }
    const resolve = (name, depth = 0) => {
      const style = styles.get(name);
      if (!style || depth > 20) return false;
      return style.hidden ?? resolve(style.parent, depth + 1);
    };
    return new Set([...styles.keys()].filter(name => resolve(name)));
  })();
  const hidden = { count: 0 };
  // Text found invisible on the rendered pages, set once the pages are drawn.
  const invisible = { nodes: null, count: 0 };
  const isHidden = (node) => node.namespaceURI === textNamespace && ['span', 'p', 'h'].includes(node.localName) && hiddenStyles.has(node.getAttributeNS(textNamespace, 'style-name'));
  const isParagraph = (node) => node.namespaceURI === textNamespace && ['p', 'h'].includes(node.localName);
  const paragraphsOf = (root) => [...root.getElementsByTagName('*')].filter((node) => isParagraph(node) && !isInsideExcluded(node));
  // Formulas keep their StarMath source, which the model can read beside the rendered formula.
  const formulaText = (href) => {
    const data = entries[`${(href || '').replace(/^\.\//, '').replace(/\/$/, '')}/content.xml`];
    if (!data) return '';
    const math = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
    if (math.querySelector('parsererror')) return '';
    const annotation = [...math.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'annotation')].find(node => /starmath/i.test(node.getAttribute('encoding') || ''));
    return (annotation?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  };
  const paragraphText = (paragraph, counter = hidden) => {
    let text = '';
    if (isHidden(paragraph)) {
      if (paragraph.textContent.trim()) counter.count++;
      return text;
    }
    const append = (value) => { countText(value.length); text += value; };
    // Walk iteratively and preserve both ordinary text and XML CDATA sections.
    // Nested paragraphs (frames, notes) are read on their own, not inside their anchor.
    const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION, {
      acceptNode: (node) => {
        if (node === paragraph || node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (isExcluded(node) || isParagraph(node)) return NodeFilter.FILTER_REJECT;
        if (isHidden(node)) {
          if (node.textContent.trim()) counter.count++;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (invisible.nodes?.has(node)) {
        if (node.textContent.trim()) invisible.count++;
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) append(node.textContent);
      else if (node.namespaceURI === drawNamespace && node.localName === 'object') {
        const formula = formulaText(node.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
        if (formula) append(`[Formula: ${formula}]`);
      } else if (node.namespaceURI === textNamespace) {
        if (node.localName === 'tab') append('\t');
        else if (node.localName === 'line-break') append('\n');
        else if (node.localName === 's') {
          const attribute = node.getAttributeNS(textNamespace, 'c');
          const count = attribute === null ? 1 : Number(attribute);
          if ((attribute !== null && !/^\+?\d+$/.test(attribute.trim())) || !Number.isSafeInteger(count) || count < 1) {
            throw new Error('Invalid ODT repeated space count.');
          }
          // Check the remaining document budget before allocating expanded spaces.
          countText(count);
          text += ' '.repeat(count);
        }
      }
    }
    return text;
  };
  const paragraphs = paragraphsOf(doc);
  const texts = new Map();
  for (const [index, paragraph] of paragraphs.entries()) {
    signal?.throwIfAborted();
    if (index) countText(1);
    texts.set(paragraph, paragraphText(paragraph));
  }
  const embeddedObjects = () => countEmbeddedObjects(names, { object: /^(Object [^/]+)\// });

  let layout = null;
  try {
    layout = await renderOdtPages({
      content: doc, styles: stylesDoc, entries, signal, encodePageImage, sniffFormat, bitmapDimensions: officeBitmapDimensions, bytesToBase64,
      maxImageCharacters: MAX_PAGE_IMAGE_CHARACTERS, maxPixels: MAX_OFFICE_IMAGE_PIXELS, pageImages, redact,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'PAGE_LIMIT') throw error;
  }
  if (!layout) {
    // Without page images the document keeps its text and embedded images, and the receipt says so.
    const textContent = paragraphs.map(paragraph => texts.get(paragraph)).join('\n');
    const { images, imageLimitations } = await readOfficeImages(Object.entries(entries).filter(([name]) => name.startsWith('Pictures/')), signal);
    if (images.length > MAX_IMAGES) throw new Error('ODT exceeds the text or image limit.');
    imageLimitations.push(...embeddedObjects(), ...hiddenTextLimitation(hidden, 'odt'), { reason: 'page-rendering-failed', format: 'odt', count: 1 });
    return { documentFormat: 'odt', mimeType: ODT_MIME_TYPE, textContent, images, imageLimitations };
  }

  // Each paragraph belongs to the page of the block that holds it; anything unplaced stays with the previous page.
  const pageOf = new Map();
  layout.pages.forEach((page, index) => {
    for (const source of page.sources) {
      if (isParagraph(source) && !pageOf.has(source)) pageOf.set(source, index);
      for (const node of source.getElementsByTagName('*')) if (isParagraph(node) && !pageOf.has(node)) pageOf.set(node, index);
    }
  });
  // Paragraphs with invisible text are read again without it.
  if (layout.invisibleSources.size) {
    invisible.nodes = layout.invisibleSources;
    textLength = 0;
    for (const [index, paragraph] of paragraphs.entries()) {
      if (index) countText(1);
      texts.set(paragraph, paragraphText(paragraph, { count: 0 }));
    }
  }
  const pageTexts = layout.pages.map(() => []);
  let pageIndex = 0;
  for (const paragraph of paragraphs) {
    pageIndex = Math.max(pageIndex, pageOf.get(paragraph) ?? pageIndex);
    pageTexts[pageIndex].push(withListLabel(layout, paragraph, texts.get(paragraph)));
  }
  // Header and footer text as drawn, with that page's number instead of whatever Writer last stored in the fields.
  addHeadersAndFooters(layout, pageTexts, invisible);
  return pagedResult(layout, pageTexts, 'odt', ODT_MIME_TYPE,
    [...layout.imageLimitations, ...hiddenTextLimitation(hidden, 'odt'), ...invisibleTextLimitation(invisible.count, 'odt')]);
};

// Spreadsheets and presentations are read into a model first (cells, slides), then drawn.
// Their page text comes from the model, leaving out what the drawn pages show invisibly.
const OFFICE_MODELS = {
  xlsx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', media: /^xl\/media\//,
    keep: (name) => /^(?:_rels\/\.rels|xl\/(?:_rels\/)?[^/]+\.(?:xml|rels)|xl\/(?:worksheets|drawings|theme)\/(?:_rels\/)?[^/]+\.(?:xml|rels))$/.test(name) || name.startsWith('xl/media/'),
    read: (entries, options) => readXlsxWorkbook({ entries, ...options }), render: (model, options) => renderXlsxPages({ workbook: model, ...options }),
    pageTexts: workbookPageTexts, flatText: workbookText,
  },
  ods: {
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet', media: /^Pictures\//, odf: true,
    read: (entries, options) => readOdsWorkbook({ entries, ...options }), render: (model, options) => renderOdsPages({ workbook: model, ...options }),
    pageTexts: workbookPageTexts, flatText: workbookText,
  },
  pptx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', media: /^ppt\/media\//,
    keep: (name) => /^(?:_rels\/\.rels|ppt\/(?:_rels\/)?[^/]+\.(?:xml|rels)|ppt\/(?:slides|slideLayouts|slideMasters|notesSlides|theme)\/(?:_rels\/)?[^/]+\.(?:xml|rels))$/.test(name) || name.startsWith('ppt/media/'),
    read: (entries, options) => readPptxPresentation({ entries, ...options }), render: (model, options) => renderPptxPages({ presentation: model, ...options }),
    pageTexts: presentationPageTexts, flatText: presentationText,
  },
  odp: {
    mimeType: 'application/vnd.oasis.opendocument.presentation', media: /^Pictures\//, odf: true,
    read: (entries, options) => readOdpPresentation({ entries, ...options }), render: (model, options) => renderOdpPages({ presentation: model, ...options }),
    pageTexts: presentationPageTexts, flatText: presentationText,
  },
};
const readOfficeModel = async (format, bytes, signal, { pageImages, redact } = {}) => {
  const definition = OFFICE_MODELS[format];
  const label = format.toUpperCase();
  let expandedBytes = 0;
  const entries = unzipSync(bytes, { filter: (entry) => {
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`${label} exceeds the decompressed size limit.`);
    return definition.odf ? ['content.xml', 'styles.xml'].includes(entry.name) || entry.name.startsWith('Pictures/') || /^Object [^/]+\/content\.xml$/.test(entry.name) : definition.keep(entry.name);
  } });
  const options = { signal, sniffFormat, bitmapDimensions: officeBitmapDimensions, bytesToBase64, maxPixels: MAX_OFFICE_IMAGE_PIXELS, maxText: MAX_TEXT };
  if (definition.odf) {
    if (!entries['content.xml']) throw unsupportedAttachment(`The file is not an OpenDocument ${format === 'ods' ? 'spreadsheet' : 'presentation'} (missing content.xml).`);
    const parse = (name) => {
      const doc = entries[name] ? new DOMParser().parseFromString(strFromU8(entries[name]), 'application/xml') : null;
      return doc?.querySelector('parsererror') ? null : doc;
    };
    options.content = parse('content.xml');
    if (!options.content) throw new Error(`Invalid ${label} XML.`);
    // Styles only shape the page images; a damaged styles.xml keeps default styles.
    options.styles = parse('styles.xml');
  }
  const model = definition.read(entries, options);
  const hidden = hiddenTextLimitation(model.hidden, format);
  let layout = null;
  try {
    layout = await definition.render(model, { signal, encodePageImage, maxImageCharacters: MAX_PAGE_IMAGE_CHARACTERS, pageImages, redact });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'PAGE_LIMIT') throw error;
  }
  if (!layout) {
    // Without page images the file keeps its text and embedded images, and the receipt says so.
    const textContent = definition.flatText(model);
    if (textContent.length > MAX_TEXT) throw new Error(`${label} exceeds the text or image limit.`);
    const { images, imageLimitations } = await readOfficeImages(Object.entries(entries).filter(([name]) => definition.media.test(name)), signal);
    if (images.length > MAX_IMAGES) throw new Error(`${label} exceeds the text or image limit.`);
    imageLimitations.push(...model.limitations.list().filter(limitation => limitation.reason === 'unsupported-embedded-object'), ...hidden, { reason: 'page-rendering-failed', format, count: 1 });
    return { documentFormat: format, mimeType: definition.mimeType, textContent, images, imageLimitations };
  }
  const { pageTexts, invisibleCount } = definition.pageTexts(model, layout.pages);
  return pagedResult(layout, pageTexts, format, definition.mimeType, [...layout.imageLimitations, ...hidden, ...invisibleTextLimitation(invisibleCount, format)]);
};

// Identify binary formats from their bytes. Names and MIME types can be wrong:
// an old .doc renamed .docx, a PNG saved as .jpg, an iPhone HEIC named .jpg, or
// a teacher file without an extension.
const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));
const sniffFormat = (bytes) => {
  if (ascii(bytes, 0, 1024).includes('%PDF-')) return 'pdf';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'ole';
  if (ascii(bytes, 4, 8) === 'ftyp') return 'iso-media';
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'bitmap';
  if (bytes.length >= 18 && bytes[0] === 0x42 && bytes[1] === 0x4d && [12, 40, 52, 56, 108, 124].includes(new DataView(bytes.buffer, bytes.byteOffset).getUint32(14, true))) return 'bitmap';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const names = [];
    let entries;
    try { entries = unzipSync(bytes, { filter: entry => { names.push(entry.name); return entry.name === 'mimetype' && entry.originalSize < 256; } }); } catch { return 'zip'; }
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('xl/workbook.xml')) return 'xlsx';
    if (names.includes('ppt/presentation.xml')) return 'pptx';
    // ODS/ODP also contain content.xml; their mimetype entry tells them apart.
    const mimetype = entries.mimetype ? strFromU8(entries.mimetype).trim() : '';
    if (names.includes('content.xml') && (!mimetype || mimetype === 'application/vnd.oasis.opendocument.text')) return 'odt';
    if (names.includes('content.xml') && mimetype === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
    if (names.includes('content.xml') && mimetype === 'application/vnd.oasis.opendocument.presentation') return 'odp';
    return 'zip';
  }
  return '';
};
const imageMimeTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

// Uint8Array.from(atob(...), mapper) boxes every byte: a 20 MB file needed about 700 MB and 4 s.
const base64ToBytes = (data) => {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

// Correcting the same submission again (other instructions, another model) reuses the
// pages already drawn. Results are kept in this document's memory only, keyed by
// the file's SHA-256 and the page-image mode, for at most 30 minutes and 8 documents.
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_ENTRIES = 8;
const CACHE_CHARACTERS = 120 * 1024 * 1024;
const readCache = new Map();
const cachedRead = async (key, read) => {
  if (!key) return read();
  const now = Date.now();
  for (const [entryKey, entry] of readCache) if (entry.expires < now) readCache.delete(entryKey);
  const hit = readCache.get(key);
  if (hit) {
    readCache.delete(key);
    readCache.set(key, hit);
    return { ...hit.result, cached: true };
  }
  const result = await read();
  // Only drawn documents are worth keeping; text and image files are read again.
  if (!result.documentFormat) return result;
  const size = (result.textContent?.length || 0) + (result.images || []).reduce((sum, image) => sum + image.base64Data.length, 0);
  if (size <= CACHE_CHARACTERS) {
    readCache.set(key, { result, size, expires: now + CACHE_TTL_MS });
    let total = [...readCache.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [entryKey, entry] of readCache) {
      if (readCache.size <= CACHE_ENTRIES && total <= CACHE_CHARACTERS) break;
      readCache.delete(entryKey);
      total -= entry.size;
    }
  }
  return result;
};
// The key covers what decides the result: the bytes (as sent), whether the file is declared text, and the page-image mode.
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const cacheKey = async (file, pageImages, studentName = '') => typeof file?.base64Data === 'string' ? [
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.base64Data)))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
  MoodliaCorrectorAttachmentSupport.isText(file) ? 'text' : 'binary', pageImages === 'all' ? 'all' : 'visual', studentName ? await digest(studentName) : '',
].join(':') : null;

// pageImages 'visual' leaves out the images of DOCX, ODT, XLSX, ODS, PPTX and ODP pages that show only text.
// studentName: the name Moodle shows for the student, covered on the page images.
export const readAttachment = async (file, { signal, pageImages = 'all', studentName = '' } = {}) => {
  signal?.throwIfAborted();
  if (typeof file.base64Data !== 'string' || file.base64Data.length > Math.ceil(MAX_READER_ATTACHMENT_BYTES / 3) * 4) throw new Error('Invalid or oversized attachment.');
  const bytes = base64ToBytes(file.base64Data);
  if (bytes.length > MAX_READER_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the 20 MB limit.');
  if (!['all', 'visual'].includes(pageImages)) pageImages = 'all';
  const redact = studentName ? MoodliaCorrectorAttachmentSupport.studentNamePattern(studentName) : null;
  // Declared text and source files stay literal text: "BM..." or "%PDF-" inside code is not a binary format.
  if (MoodliaCorrectorAttachmentSupport.isText(file)) {
    const textContent = MoodliaCorrectorAttachmentSupport.decodeText(bytes);
    if (textContent.length > MAX_TEXT) throw new Error('Attachment exceeds the text limit.');
    return { textContent };
  }
  const sniffed = sniffFormat(bytes);
  const declaredDocument = file.mimeType === 'application/pdf' || /\.(pdf|docx|odt|xlsx|ods|pptx|odp)$/i.test(file.name) ||
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text',
      ...Object.values(OFFICE_MODELS).map(definition => definition.mimeType)].includes(file.mimeType);
  // Content decides the reader for recognised binaries; unknown names still need a supported declaration.
  if (sniffed === 'pdf') return readPdf(bytes, signal, redact);
  if (sniffed === 'docx') return readDocx(bytes, signal, { pageImages, redact });
  if (sniffed === 'odt') return readOdt(bytes, signal, { pageImages, redact });
  if (OFFICE_MODELS[sniffed]) return readOfficeModel(sniffed, bytes, signal, { pageImages, redact });
  if (sniffed === 'ole') throw unsupportedAttachment('Legacy Office binary file (.doc/.xls/.ppt). Save it as DOCX, XLSX, PPTX, an OpenDocument format or PDF.');
  if (['zip', 'iso-media', 'bitmap'].includes(sniffed)) throw unsupportedAttachment('Unsupported attachment format.');
  if (imageMimeTypes[sniffed]) return { mimeType: imageMimeTypes[sniffed], images: [{ mimeType: imageMimeTypes[sniffed], base64Data: file.base64Data }] };
  // A declared PDF or Office document whose bytes match none of the formats is damaged, not a different format.
  if (declaredDocument) throw new Error('The document is damaged or incomplete and cannot be read.');
  if (MoodliaCorrectorAttachmentSupport.assess(file).supported === false) throw unsupportedAttachment('Unsupported attachment format.');
  // A file without an extension and without NUL bytes is read as text.
  const declaredImage = /^image\//.test(file.mimeType || '') || /\.(png|jpe?g|webp)$/i.test(file.name || '');
  if (!declaredImage && !/\.[a-z0-9]{1,8}$/i.test(file.name || '') && !bytes.includes(0)) {
    const textContent = MoodliaCorrectorAttachmentSupport.decodeText(bytes);
    if (textContent.length > MAX_TEXT) throw new Error('Attachment exceeds the text limit.');
    return { textContent };
  }
  throw unsupportedAttachment('Unsupported attachment. Use text, PDF, DOCX, ODT, XLSX, ODS, PPTX, ODP, PNG, JPEG, or WebP.');
};

// Requests from the service worker go through the cache; direct calls to readAttachment do not.
export const readAttachmentCached = async (file, options = {}) => cachedRead(await cacheKey(file, options.pageImages, options.studentName), () => readAttachment(file, options));

const activeReads = new Map();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'attachment-reader' || sender.id !== chrome.runtime.id) return false;
  if (message.type === 'mca.cancelAttachmentRead') {
    activeReads.get(message.requestId)?.abort(new Error('Local attachment extraction cancelled.'));
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== 'mca.readAttachment') return false;
  const controller = new AbortController();
  const requestId = message.requestId || crypto.randomUUID();
  activeReads.set(requestId, controller);
  void readAttachmentCached(message.file, { signal: controller.signal, pageImages: message.pageImages, studentName: message.studentName })
    .then((attachment) => sendResponse({ ok: true, attachment }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Local extraction failed.', errorCode: error.code }))
    .finally(() => activeReads.delete(requestId));
  return true;
});
