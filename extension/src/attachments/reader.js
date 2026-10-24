import { getDocument, GlobalWorkerOptions } from '../../lib/pdf.mjs';
import { unzipSync, strFromU8 } from '../../lib/fflate.mjs';
import '../attachmentSupport.js';

const unsupportedAttachment = (message) => Object.assign(new Error(message), { code: 'UNSUPPORTED_ATTACHMENT' });

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');
const { MAX_TEXT, MAX_IMAGES, MAX_EXPANDED_BYTES, bytesToBase64 } = MoodliaCorrectorAttachmentSupport;

const readPdf = async (bytes) => {
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true,
    standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
    cMapUrl: chrome.runtime.getURL('lib/cmaps/'), cMapPacked: true,
    wasmUrl: chrome.runtime.getURL('lib/wasm/'),
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 60) throw new Error('PDF exceeds the 60 page limit.');
    const sections = [];
    const images = [];
    let textLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
      textLength += text.length;
      if (textLength > MAX_TEXT) throw new Error('PDF exceeds the text limit.');
      if (text) sections.push(`Page ${pageNumber}\n${text}`);
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
        images.push({ pageNumber, mimeType: 'image/png', base64Data: canvas.toDataURL('image/png').split(',')[1] });
        canvas.width = canvas.height = 0;
        sections.push(`Page ${pageNumber}: visual content attached as an image.`);
      }
      page.cleanup();
    }
    return { textContent: sections.join('\n\n'), images };
  } finally { await task.destroy(); }
};

const readDocx = (bytes) => {
  let expandedBytes = 0;
  const entries = unzipSync(bytes, { filter: (entry) => {
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('DOCX exceeds the decompressed size limit.');
    return /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(entry.name) || entry.name.startsWith('word/media/');
  } });
  if (!entries['word/document.xml']) throw new Error('Invalid DOCX: missing document text.');
  const texts = [];
  const images = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('.xml')) {
      const doc = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid DOCX XML.');
      texts.push([...doc.getElementsByTagNameNS('*', 'p')].map((paragraph) =>
        [...paragraph.getElementsByTagNameNS('*', 't')].map((node) => node.textContent).join('')
      ).join('\n'));
    } else {
      const mimeType = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : '';
      if (!mimeType) throw unsupportedAttachment('DOCX contains an unsupported image format. Export it as PDF.');
      images.push({ mimeType, base64Data: bytesToBase64(data) });
    }
  }
  const textContent = texts.join('\n\n');
  if (textContent.length > MAX_TEXT || images.length > MAX_IMAGES) throw new Error('DOCX exceeds the text or image limit.');
  return { textContent, images };
};

const readOdt = (bytes) => {
  let expandedBytes = 0;
  const entries = unzipSync(bytes, { filter: (entry) => {
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('ODT exceeds the decompressed size limit.');
    return entry.name === 'content.xml' || entry.name.startsWith('Pictures/');
  } });
  if (!entries['content.xml']) throw new Error('Invalid ODT: missing document text.');
  const doc = new DOMParser().parseFromString(strFromU8(entries['content.xml']), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid ODT XML.');
  const textNamespace = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const textContent = [...doc.getElementsByTagName('*')]
    .filter((node) => node.namespaceURI === textNamespace && ['p', 'h'].includes(node.localName))
    .map((node) => node.textContent).join('\n');
  const images = [];
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith('Pictures/') || !data.length) continue;
    const mimeType = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : '';
    if (!mimeType) throw unsupportedAttachment('ODT contains an unsupported image format. Export it as PDF.');
    images.push({ mimeType, base64Data: bytesToBase64(data) });
  }
  if (textContent.length > MAX_TEXT || images.length > MAX_IMAGES) throw new Error('ODT exceeds the text or image limit.');
  return { textContent, images };
};

export const readAttachment = async (file) => {
  if (MoodliaCorrectorAttachmentSupport.assess(file).supported === false) throw unsupportedAttachment('Unsupported attachment format.');
  if (typeof file.base64Data !== 'string' || file.base64Data.length > 6 * 1024 * 1024) throw new Error('Invalid or oversized attachment.');
  const bytes = Uint8Array.from(atob(file.base64Data), (character) => character.charCodeAt(0));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Attachment exceeds the 4 MB limit.');
  if (MoodliaCorrectorAttachmentSupport.isText(file)) {
    const textContent = new TextDecoder().decode(bytes);
    if (textContent.length > MAX_TEXT) throw new Error('Attachment exceeds the text limit.');
    return { textContent };
  }
  if (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name)) return readPdf(bytes);
  if (/\.docx$/i.test(file.name) || file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return readDocx(bytes);
  if (/\.odt$/i.test(file.name) || file.mimeType === 'application/vnd.oasis.opendocument.text') return readOdt(bytes);
  const mimeType = /^image\/(png|jpeg|webp)$/.test(file.mimeType) ? file.mimeType
    : /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : '';
  if (mimeType) return { images: [{ mimeType, base64Data: file.base64Data }] };
  throw unsupportedAttachment('Unsupported attachment. Use text, PDF, DOCX, ODT, PNG, JPEG, or WebP.');
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'attachment-reader' || message.type !== 'mca.readAttachment' || sender.id !== chrome.runtime.id) return false;
  void readAttachment(message.file)
    .then((attachment) => sendResponse({ ok: true, attachment }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Local extraction failed.', errorCode: error.code }));
  return true;
});
