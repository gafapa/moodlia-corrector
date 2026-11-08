import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { odpFile, odsCell, odsFile, odsNumber, pptxFile, pptxFrame, pptxPicture, pptxRun, pptxShape, solidPng, xlsxFile } from './fixtures/office-models.mjs';

const odtDocument = (body) => `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
const odtFile = (body) => ({ name: 'fictional.odt', base64Data: Buffer.from(zipSync({ 'content.xml': strToU8(odtDocument(body)) })).toString('base64') });

export async function checkAttachmentReader(page, extensionId) {
  const read = (file) => page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    try { return { attachment: await readAttachment(file) }; }
    catch (error) { return { error: error.message }; }
  }, { extensionId, file });

  const preserved = await read(odtFile('<text:h>Heading</text:h><text:p>Before <![CDATA[ESSENTIAL <answer> & code]]><text:span><text:tab/>nested<![CDATA[ CDATA]]></text:span><text:line-break/>After<text:s/><text:s text:c="3"/>end</text:p>'));
  assert.equal(preserved.attachment.textContent, 'Page 1\nHeading\nBefore ESSENTIAL <answer> & code\tnested CDATA\nAfter    end\n\nPage 1: visual content attached as an image.');
  assert.equal(preserved.attachment.pageCount, 1);
  assert.deepEqual(preserved.attachment.images.map(image => image.pageNumber), [1]);
  console.log('PASS: ODT extraction preserves CDATA, nested text, tabs, breaks and repeated spaces.');

  // LibreOffice Writer/Web, master documents and templates store other mimetype entries over the same office:text body.
  for (const variant of ['text', 'text-web', 'text-template', 'text-master']) {
    const mimetype = `application/vnd.oasis.opendocument.${variant}`;
    const variantFile = { name: 'fictional.odt', base64Data: Buffer.from(zipSync({ mimetype: [strToU8(mimetype), { level: 0 }], 'content.xml': strToU8(odtDocument('<text:p>Variant answer</text:p>')) })).toString('base64') };
    const variantRead = await read(variantFile);
    assert.equal(variantRead.error, undefined, mimetype);
    assert.match(variantRead.attachment.textContent, /Variant answer/, mimetype);
  }
  console.log('PASS: ODT text, Writer/Web, template and master mimetypes are read as OpenDocument text.');

  const maxText = await page.evaluate(() => MoodliaCorrectorAttachmentSupport.MAX_TEXT);
  const exact = await read(odtFile(`<text:p>A<text:s text:c="${maxText - 3}"/></text:p><text:p>B</text:p>`));
  assert.equal(exact.attachment.extractedTextCharacters, maxText);
  assert.ok(exact.attachment.textContent.startsWith('Page 1\nA '));
  assert.ok(exact.attachment.textContent.endsWith('\nB\n\nPage 1: visual content attached as an image.'));
  for (const body of [
    '<text:p><text:s text:c="1000000000"/></text:p>',
    `<text:p><text:s text:c="${maxText / 2 + 1}"/><text:s text:c="${maxText / 2}"/></text:p>`,
    `<text:p>A<text:s text:c="${maxText - 2}"/></text:p><text:p>B</text:p>`,
    `<text:p><![CDATA[${'x'.repeat(maxText + 1)}]]></text:p>`,
  ]) {
    // Guard the reproduction itself: a broken reader must never allocate huge strings.
    const result = await page.evaluate(async ({ extensionId, file }) => {
      const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
      const originalRepeat = String.prototype.repeat;
      const maxText = MoodliaCorrectorAttachmentSupport.MAX_TEXT;
      let expandedSpaces = 0;
      String.prototype.repeat = function (count) {
        if (String(this) === ' ') {
          expandedSpaces += count;
          if (expandedSpaces > maxText) throw new Error('Test blocked allocation beyond the document budget.');
        }
        return originalRepeat.call(this, count);
      };
      try { await readAttachment(file); return { succeeded: true, expandedSpaces }; }
      catch (error) { return { error: error.message, expandedSpaces }; }
      finally { String.prototype.repeat = originalRepeat; }
    }, { extensionId, file: odtFile(body) });
    assert.match(result.error || '', /ODT exceeds the text or image limit/);
    assert.ok(result.expandedSpaces <= maxText);
  }
  for (const count of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '1e6', '9007199254740992']) {
    const result = await read(odtFile(`<text:p><text:s text:c="${count}"/></text:p>`));
    assert.match(result.error || '', /Invalid ODT repeated space count/, count);
  }
  console.log('PASS: ODT text limits include all paragraphs and CDATA, reject invalid counts and stop space expansion before allocation.');

  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const hugeGif = Buffer.from(gif);
  hugeGif.writeUInt16LE(65535, 6);
  hugeGif.writeUInt16LE(65535, 8);
  const guardedFile = {
    name: 'fictional.odt', base64Data: Buffer.from(zipSync({
      'content.xml': strToU8(odtDocument('<text:p>Readable answer beside an oversized image.<draw:frame xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:image xlink:href="Pictures/huge.gif"/></draw:frame></text:p>')),
      'Pictures/huge.gif': hugeGif,
    })).toString('base64'),
  };
  const guarded = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const original = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = async () => { decodeCalls++; throw new Error('Test must not decode oversized pixels.'); };
    try { return { attachment: await readAttachment(file), decodeCalls }; }
    finally { globalThis.createImageBitmap = original; }
  }, { extensionId, file: guardedFile });
  assert.equal(guarded.decodeCalls, 0);
  assert.match(guarded.attachment.textContent, /Readable answer/);
  assert.deepEqual(guarded.attachment.imageLimitations, [{ reason: 'embedded-image-size-limit', format: 'gif', count: 1 }]);
  console.log('PASS: embedded GIF/BMP dimensions are bounded before decoding and omitted images retain the readable document text.');
  // Embedded images are drawn inside page images; GIF conversion runs when page rendering fails.
  for (const format of ['docx', 'odt']) {
    const prefix = format === 'docx' ? 'word/media/' : 'Pictures/';
    const document = format === 'docx'
      ? { 'word/document.xml': strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Fictional answer</w:t></w:r></w:p></w:body></w:document>') }
      : { 'content.xml': strToU8(odtDocument('<text:p>Fictional answer</text:p>')) };
    const file = { name: `fictional.${format}`, base64Data: Buffer.from(zipSync({ ...document, [`${prefix}first.gif`]: gif, [`${prefix}second.gif`]: gif })).toString('base64') };
    for (const phase of ['decoded', 'decode-rejected', 'encoded']) {
      const result = await page.evaluate(async ({ extensionId, file, phase }) => {
        const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
        const controller = new AbortController();
        const originalDecode = globalThis.createImageBitmap;
        const originalEncode = HTMLCanvasElement.prototype.toDataURL;
        const originalSerialize = XMLSerializer.prototype.serializeToString;
        XMLSerializer.prototype.serializeToString = () => { throw new Error('Fictional rendering failure'); };
        let conversionCalls = 0;
        let closedBitmaps = 0;
        const canvases = [];
        globalThis.createImageBitmap = async (...args) => {
          conversionCalls++;
          if (phase === 'decode-rejected') {
            controller.abort(new Error('Fictional Office cancellation'));
            throw new Error('Fictional decode interruption');
          }
          const bitmap = await originalDecode(...args);
          const originalClose = bitmap.close.bind(bitmap);
          bitmap.close = () => { closedBitmaps++; originalClose(); };
          if (phase === 'decoded') controller.abort(new Error('Fictional Office cancellation'));
          return bitmap;
        };
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          const data = originalEncode.apply(this, args);
          canvases.push(this);
          if (phase === 'encoded') controller.abort(new Error('Fictional Office cancellation'));
          return data;
        };
        try {
          await readAttachment(file, { signal: controller.signal });
          return { succeeded: true };
        } catch (error) {
          return { error: error.message, conversionCalls, closedBitmaps, canvasesReleased: canvases.every(canvas => canvas.width === 0 && canvas.height === 0) };
        } finally {
          globalThis.createImageBitmap = originalDecode;
          HTMLCanvasElement.prototype.toDataURL = originalEncode;
          XMLSerializer.prototype.serializeToString = originalSerialize;
        }
      }, { extensionId, file, phase });
      assert.match(result.error || '', /Fictional Office cancellation/, `${format}: ${phase}`);
      assert.equal(result.conversionCalls, 1, `${format}: ${phase} must not decode the second image`);
      assert.equal(result.closedBitmaps, phase === 'decode-rejected' ? 0 : 1, `${format}: ${phase} must close decoded bitmaps`);
      assert.equal(result.canvasesReleased, true, `${format}: ${phase} must release canvases`);
    }
  }
  console.log('PASS: DOCX and ODT fallback cancellation stops subsequent conversions, preserves the cancellation error and releases bitmaps/canvases.');
  const twoPageDocx = { name: 'pages.docx', base64Data: Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:lastRenderedPageBreak/><w:t>Second</w:t></w:r></w:p></w:body></w:document>') })).toString('base64') };
  for (const file of [odtFile('<text:p>First</text:p><text:soft-page-break/><text:p>Second</text:p>'), twoPageDocx]) {
  const odtCancel = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const controller = new AbortController();
    const originalEncode = HTMLCanvasElement.prototype.toDataURL;
    const canvases = [];
    let encodeCalls = 0;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      encodeCalls++;
      canvases.push(this);
      controller.abort(new Error('Fictional ODT cancellation'));
      return originalEncode.apply(this, args);
    };
    try { await readAttachment(file, { signal: controller.signal }); return { succeeded: true }; }
    catch (error) { return { error: error.message, encodeCalls, released: canvases.every(canvas => canvas.width === 0), leftovers: document.querySelectorAll('.doc-page').length }; }
    finally { HTMLCanvasElement.prototype.toDataURL = originalEncode; }
  }, { extensionId, file });
  assert.match(odtCancel.error || '', /Fictional ODT cancellation/, file.name);
  assert.equal(odtCancel.encodeCalls, 1, `${file.name} cancellation must stop before the second page`);
  assert.equal(odtCancel.released, true);
  assert.equal(odtCancel.leftovers, 0);
  }
  console.log('PASS: DOCX and ODT cancellation stops page rendering, preserves the cancellation error and removes the layout.');

  // Word stores a text box as mc:Choice plus a VML mc:Fallback copy, nested in its anchor paragraph.
  const wordNamespaces = 'xmlns:w="urn:w" xmlns:mc="urn:mc" xmlns:wps="urn:wps" xmlns:v="urn:v" xmlns:wp="urn:wp" xmlns:a="urn:a" xmlns:c="urn:c"';
  const textBox = '<w:txbxContent><w:p><w:r><w:t>BOXTEXT</w:t></w:r></w:p></w:txbxContent>';
  const docxBody = `<w:document ${wordNamespaces}><w:body><w:p><w:r><w:t>Body.</w:t></w:r><w:r><mc:AlternateContent><mc:Choice><w:drawing><wps:txbx>${textBox}</wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox>${textBox}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>a</w:t><w:noBreakHyphen/><w:t>b</w:t></w:r><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><c:chart/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:object><v:shape/></w:object></w:r></w:p></w:body></w:document>`;
  const docx = await read({ name: 'textbox.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(docxBody), 'word/charts/chart1.xml': strToU8('<c/>'), 'word/embeddings/object1.bin': strToU8('x'),
  })).toString('base64') });
  assert.equal(docx.attachment.textContent, 'Page 1\nBody.a-b\nBOXTEXT\n\nPage 1: visual content attached as an image.');
  assert.deepEqual(docx.attachment.imageLimitations, [
    { reason: 'unsupported-embedded-object', format: 'chart', count: 1 }, { reason: 'unsupported-embedded-object', format: 'object', count: 1 },
  ]);
  console.log('PASS: DOCX text boxes are read once, without their VML fallback copy, and charts/objects are reported.');

  const odtNamespaces = 'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';
  const odtXml = `<office:document-content ${odtNamespaces}><office:body><office:text><text:tracked-changes><text:changed-region><text:deletion><text:p>DELETEDTEXT</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Before<draw:frame><svg:title>ALT</svg:title><draw:text-box><text:p>FRAMETEXT</text:p></draw:text-box></draw:frame>After</text:p><text:p>Claim<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>NOTETEXT</text:p></text:note-body></text:note>.</text:p><text:p><draw:frame text:anchor-type="as-char"><draw:object xlink:href="./Object 1"/></draw:frame>Answer<office:annotation><dc:creator>Teacher</dc:creator><text:p>COMMENT</text:p></office:annotation>.</text:p></office:text></office:body></office:document-content>`;
  const odt = await read({ name: 'review.odt', base64Data: Buffer.from(zipSync({ 'content.xml': strToU8(odtXml), 'Object 1/content.xml': strToU8('<math/>') })).toString('base64') });
  assert.equal(odt.attachment.textContent, 'Page 1\nBeforeAfter\nFRAMETEXT\nClaim1.\nNOTETEXT\nAnswer.\n\nPage 1: visual content attached as an image.');
  assert.deepEqual(odt.attachment.imageLimitations, [{ reason: 'unsupported-embedded-object', format: 'object', count: 1 }]);
  console.log('PASS: ODT frames and notes are read once; comments, tracked deletions and alt text are excluded.');

  // Formats come from the bytes: a renamed .doc, a PNG named .jpg and a teacher file without extension.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const legacy = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    try { return await readAttachment(file); } catch (error) { return { error: error.message, code: error.code }; }
  }, { extensionId, file: { name: 'renamed.docx', base64Data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).toString('base64') } });
  assert.equal(legacy.code, 'UNSUPPORTED_ATTACHMENT');
  assert.match(legacy.error, /Legacy Office binary/);
  const disguised = await read({ name: 'photo.jpg', mimeType: 'image/jpeg', base64Data: png.toString('base64') });
  assert.equal(disguised.attachment.images[0].mimeType, 'image/png');
  assert.equal(disguised.attachment.mimeType, 'image/png');
  const plain = await read({ name: 'NOTES', mimeType: '', base64Data: Buffer.from('Teacher notes without extension').toString('base64') });
  assert.equal(plain.attachment.textContent, 'Teacher notes without extension');
  const bmiText = await read({ name: 'bmi.txt', base64Data: Buffer.from('BMI calculator notes').toString('base64') });
  assert.equal(bmiText.attachment.textContent, 'BMI calculator notes');
  console.log('PASS: binary formats are identified from their bytes; declared text stays text.');

  // A scanned page compresses badly as PNG; JPEG keeps each page within the transfer budget.
  const scan = await page.evaluate(async (extensionId) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1240; canvas.height = 1754;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const value = 190 + Math.floor(Math.random() * 60);
      pixels.data.set([value, value - 5, value - 15, 255], index);
    }
    context.putImageData(pixels, 0, 0);
    const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.6))).arrayBuffer());
    const encoder = new TextEncoder();
    const pages = 3;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
      [encoder.encode(`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, encoder.encode('\nendstream')]];
    for (let i = 0; i < pages; i++) {
      const content = 'q 595 0 0 842 0 0 cm /Im1 Do Q';
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
      objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    const parts = [encoder.encode('%PDF-1.4\n')];
    let length = parts[0].length;
    const offsets = [];
    for (const [index, object] of objects.entries()) {
      offsets.push(length);
      for (const part of [encoder.encode(`${index + 1} 0 obj\n`), ...(Array.isArray(object) ? object : [encoder.encode(object)]), encoder.encode('\nendobj\n')]) { parts.push(part); length += part.length; }
    }
    parts.push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const result = await readAttachment({ name: 'scan.pdf', base64Data: MoodliaCorrectorAttachmentSupport.bytesToBase64(bytes) });
    return { types: result.images.map(image => image.mimeType), sizes: result.images.map(image => image.base64Data.length), extracted: result.extractedTextCharacters };
  }, extensionId);
  assert.deepEqual(scan.types, ['image/jpeg', 'image/jpeg', 'image/jpeg']);
  assert.ok(scan.sizes.every(size => size <= 1_200_000), `page sizes ${scan.sizes}`);
  assert.equal(scan.extracted, 0);
  console.log('PASS: scanned PDF pages fall back to JPEG within the per-page budget and report no extracted text.');

  // ODT pages: soft page breaks, a page style with a header and page fields, a repeated table header and a formula.
  const layoutNamespaces = `${odtNamespaces} xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"`;
  const layoutStyles = `<office:document-styles ${layoutNamespaces}><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin="2cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>FICTIONAL HEADER <text:page-number>1</text:page-number>/<text:page-count>1</text:page-count></text:p></style:header></style:master-page></office:master-styles></office:document-styles>`;
  const formula = '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><annotation encoding="StarMath 5.0">x + 1</annotation></semantics></math>';
  const headerRow = '<table:table-header-rows><table:table-row><table:table-cell><text:p>HEADCELL</text:p></table:table-cell></table:table-row></table:table-header-rows>';
  const layoutContent = `<office:document-content ${layoutNamespaces}><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:background-color="url(https://evil.invalid/x.png)"/><style:text-properties fo:color="#c00000"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="P1">FIRST PAGE<draw:frame text:anchor-type="as-char"><draw:object xlink:href="./Object 1"/></draw:frame><draw:frame text:anchor-type="as-char"><draw:image xlink:href="https://evil.invalid/remote.png"/></draw:frame></text:p><table:table>${headerRow}<table:table-row><table:table-cell><text:p>ROW ONE</text:p></table:table-cell></table:table-row><text:soft-page-break/><table:table-row><table:table-cell><text:p>ROW TWO</text:p></table:table-cell></table:table-row></table:table><text:p>SECOND PAGE</text:p></office:text></office:body></office:document-content>`;
  const layoutFile = { name: 'layout.odt', base64Data: Buffer.from(zipSync({ 'content.xml': strToU8(layoutContent), 'styles.xml': strToU8(layoutStyles), 'Object 1/content.xml': strToU8(formula) })).toString('base64') };
  const remoteRequests = [];
  const onRequest = (request) => { if (request.url().includes('evil.invalid')) remoteRequests.push(request.url()); };
  page.on('request', onRequest);
  const layout = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const result = await readAttachment(file);
    const sizes = [];
    for (const image of result.images) {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
      let dark = 0;
      let red = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 100 && pixels[index + 1] < 100) dark++;
        if (pixels[index] > 150 && pixels[index + 1] < 60 && pixels[index + 2] < 60) red++;
      }
      sizes.push({ width: bitmap.width, height: bitmap.height, dark, red });
      bitmap.close();
    }
    return { ...result, images: result.images.map(image => ({ pageNumber: image.pageNumber, mimeType: image.mimeType })), sizes };
  }, { extensionId, file: layoutFile });
  page.off('request', onRequest);
  assert.equal(layout.pageCount, 2);
  assert.deepEqual(layout.images.map(image => image.pageNumber), [1, 2]);
  assert.deepEqual(layout.textPages.map(page => page.pageNumber), [1, 2]);
  const [firstPageText, secondPageText] = layout.textPages.map(page => layout.textContent.slice(page.start, page.end));
  assert.match(firstPageText, /^Page 1\n\[Header\]\nFICTIONAL HEADER 1\/2\nFIRST PAGE\[Formula: x \+ 1\]\nHEADCELL\nROW ONE/);
  assert.match(secondPageText, /Page 2\nROW TWO\nSECOND PAGE\n\nPage 2: visual content attached as an image\.$/);
  // A4 at the same resolution as a rendered PDF page, with visible text and the red paragraph style.
  for (const size of layout.sizes) {
    assert.equal(size.width, 1191);
    assert.ok(Math.abs(size.height - 1685) <= 2, `page height ${size.height}`);
    assert.ok(size.dark > 500, 'page images must contain rendered text');
  }
  assert.ok(layout.sizes[0].red > 100, 'paragraph colour must be rendered');
  assert.deepEqual(layout.imageLimitations, [{ reason: 'external-linked-image', format: 'link', count: 1 }]);
  assert.deepEqual(remoteRequests, []);
  console.log('PASS: ODT documents become page images with page text, headers, page fields, repeated table headers and formulas; remote images and style URLs are never loaded.');

  const manyPages = await read(odtFile(Array.from({ length: 61 }, (_, index) => `<text:p>Page ${index + 1}</text:p>`).join('<text:soft-page-break/>')));
  assert.match(manyPages.error || '', /ODT exceeds the 60 page limit/);
  const fallback = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const originalSerialize = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = () => { throw new Error('Fictional rendering failure'); };
    try { return await readAttachment(file); }
    finally { XMLSerializer.prototype.serializeToString = originalSerialize; }
  }, { extensionId, file: odtFile('<text:p>Readable without page images</text:p>') });
  assert.equal(fallback.textContent, 'Readable without page images');
  assert.equal(fallback.pageCount, undefined);
  assert.deepEqual(fallback.imageLimitations, [{ reason: 'page-rendering-failed', format: 'odt', count: 1 }]);
  console.log('PASS: ODT documents stop above 60 pages, and a page-rendering failure keeps the text and reports the missing page images.');

  // DOCX pages: Word's saved page breaks, a header with centre and right tab stops, PAGE/NUMPAGES fields,
  // a repeated header row, a table style's first-row shading, multilevel numbering, an equation and a footnote.
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const run = (value, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${value}</w:t></w:r>`;
  const numbered = (value, level) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(value)}</w:p>`;
  const equation = '<m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den></m:f></m:oMath>';
  const wordRow = (value) => `<w:tr><w:tc><w:p>${run(value)}</w:p></w:tc></w:tr>`;
  const wordDocument = `<w:document ${w}><w:body>
    <w:p>${run('RED TITLE', '<w:color w:val="C00000"/><w:sz w:val="48"/>')}</w:p>
    ${numbered('Level one', 0)}${numbered('Level two', 1)}
    <w:p>${run('Equation ')}${equation}<w:r><w:footnoteReference w:id="1"/></w:r></w:p>
    <w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblLook w:firstRow="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p>${run('HEADROW')}</w:p></w:tc></w:tr>${wordRow('ROW ONE')}
      <w:tr><w:tc><w:p><w:r><w:lastRenderedPageBreak/><w:t>ROW TWO</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p>${run('SECOND PAGE')}</w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/></w:sectPr>
  </w:body></w:document>`;
  const wordStyles = `<w:styles ${w}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"/><w:style w:type="table" w:styleId="Grid"><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr><w:tblStylePr w:type="firstRow"><w:tcPr><w:shd w:val="clear" w:fill="4472C4"/></w:tcPr></w:tblStylePr></w:style></w:styles>`;
  const wordNumbering = `<w:numbering ${w}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const wordHeader = `<w:hdr ${w}><w:p><w:pPr><w:tabs><w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/></w:tabs></w:pPr>${run('LEFT')}<w:r><w:tab/></w:r>${run('CENTRE')}<w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('9')}<w:r><w:fldChar w:fldCharType="end"/></w:r>${run('/')}<w:fldSimple w:instr=" NUMPAGES ">${run('9')}</w:fldSimple></w:p></w:hdr>`;
  const wordFootnotes = `<w:footnotes ${w}><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(' WORD FOOTNOTE')}</w:p></w:footnote></w:footnotes>`;
  const wordRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>';
  const wordFile = { name: 'layout.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(wordDocument), 'word/styles.xml': strToU8(wordStyles), 'word/numbering.xml': strToU8(wordNumbering),
    'word/header1.xml': strToU8(wordHeader), 'word/footnotes.xml': strToU8(wordFootnotes), 'word/_rels/document.xml.rels': strToU8(wordRels),
  })).toString('base64') };
  const wordLayout = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const result = await readAttachment(file);
    const sizes = [];
    for (const image of result.images) {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
      let red = 0;
      let blue = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 150 && pixels[index + 1] < 60 && pixels[index + 2] < 60) red++;
        if (pixels[index] > 50 && pixels[index] < 90 && pixels[index + 1] > 100 && pixels[index + 1] < 130 && pixels[index + 2] > 180) blue++;
      }
      sizes.push({ width: bitmap.width, height: bitmap.height, red, blue });
      bitmap.close();
    }
    return { ...result, images: result.images.map(image => ({ pageNumber: image.pageNumber })), sizes };
  }, { extensionId, file: wordFile });
  assert.equal(wordLayout.pageCount, 2);
  assert.deepEqual(wordLayout.images.map(image => image.pageNumber), [1, 2]);
  const [wordFirst, wordSecond] = wordLayout.textPages.map(page => wordLayout.textContent.slice(page.start, page.end));
  assert.match(wordFirst, /^Page 1\n\[Header\]\nLEFT\s*CENTRE\s*1\/2\nRED TITLE\n1\. Level one\n1\.1\. Level two\nEquation \[Formula: a\/\(b\^2\)\]\nHEADROW\nROW ONE\n\[Footnotes\]\nWORD FOOTNOTE/);
  assert.match(wordSecond, /^\n\nPage 2\nROW TWO\nSECOND PAGE\n\nPage 2: visual content attached as an image\.$/);
  for (const size of wordLayout.sizes) {
    assert.equal(size.width, 1191);
    assert.ok(Math.abs(size.height - 1685) <= 2, `page height ${size.height}`);
  }
  assert.ok(wordLayout.sizes[0].red > 100, 'run colour must be rendered');
  assert.ok(wordLayout.sizes[0].blue > 100 && wordLayout.sizes[1].blue > 100, 'the shaded header row must repeat on both pages');
  assert.deepEqual(wordLayout.imageLimitations, []);
  console.log('PASS: DOCX documents become page images with Word page breaks, header tab stops and page fields, numbering, table styles, equations and footnotes.');

  const manyWordPages = await read({ name: 'long.docx', base64Data: Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document ${w}><w:body>${Array.from({ length: 61 }, (_, index) => `<w:p><w:r>${index ? '<w:lastRenderedPageBreak/>' : ''}<w:t>Page ${index + 1}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`) })).toString('base64') });
  assert.match(manyWordPages.error || '', /DOCX exceeds the 60 page limit/);
  const wordFallback = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const originalSerialize = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = () => { throw new Error('Fictional rendering failure'); };
    try { return await readAttachment(file); }
    finally { XMLSerializer.prototype.serializeToString = originalSerialize; }
  }, { extensionId, file: twoPageDocx });
  assert.equal(wordFallback.textContent, 'First\nSecond');
  assert.deepEqual(wordFallback.imageLimitations, [{ reason: 'page-rendering-failed', format: 'docx', count: 1 }]);
  console.log('PASS: DOCX documents stop above 60 pages, and a page-rendering failure keeps the text and reports the missing page images.');

  // Review 0.2.1 regressions.
  const tableNamespaces = 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';
  const innerTable = `<table:table>${'<table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="256"><text:p>x</text:p></table:table-cell></table:table-row>'}</table:table>`;
  const nested = `<table:table ${tableNamespaces}><table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="2">${innerTable}</table:table-cell></table:table-row></table:table>`;
  const nestedStarted = Date.now();
  const multiplied = await read(odtFile(nested));
  assert.match(multiplied.error || '', /ODT tables exceed the 200,000 element limit/);
  assert.ok(Date.now() - nestedStarted < 15000, `nested repeats took ${Date.now() - nestedStarted} ms`);
  console.log('PASS: repeated cells and rows in nested ODT tables stop at an element budget instead of hanging the reader.');

  const hiddenDocx = await read({ name: 'hidden.docx', base64Data: Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document ${w}><w:body><w:p>${run('Visible.')}${run('HIDDEN-INSTRUCTION', '<w:vanish/>')}</w:p></w:body></w:document>`) })).toString('base64') });
  assert.doesNotMatch(hiddenDocx.attachment.textContent, /HIDDEN-INSTRUCTION/);
  assert.deepEqual(hiddenDocx.attachment.imageLimitations, [{ reason: 'hidden-text-excluded', format: 'docx', count: 1 }]);
  const hiddenOdt = await read({ name: 'hidden.odt', base64Data: Buffer.from(zipSync({ 'content.xml': strToU8(`<office:document-content ${layoutNamespaces}><office:automatic-styles><style:style style:name="H" style:family="text"><style:text-properties text:display="none"/></style:style></office:automatic-styles><office:body><office:text><text:p>Visible<text:span text:style-name="H">HIDDEN-ODT</text:span></text:p></office:text></office:body></office:document-content>`) })).toString('base64') });
  assert.doesNotMatch(hiddenOdt.attachment.textContent, /HIDDEN-ODT/);
  assert.deepEqual(hiddenOdt.attachment.imageLimitations, [{ reason: 'hidden-text-excluded', format: 'odt', count: 1 }]);
  console.log('PASS: hidden DOCX and ODT text is not sent as text, because it is not drawn on the page, and the receipt counts it.');

  const notesFile = { name: 'notes.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${w}><w:body><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p>${run('HEAD')}<w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p>${run('BODY')}</w:p></w:tc></w:tr></w:tbl><w:p>${run('Alpha')}<w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:endnoteReference w:id="3"/></w:r></w:p><w:p>${run('FILE: ')}<w:fldSimple w:instr=" FILENAME ">${run('student-name.docx')}</w:fldSimple><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> FILENAME \\p </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('C:/private/path.docx')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:r><w:sym w:font="Symbol" w:char="FFFFFFF"/><w:sym w:font="Arial" w:char="0001"/></w:r>${run('SYMBOLS')}</w:p><w:p>${run('PAGE-ONE')}<w:r><w:br w:type="page"/><w:t>PAGE-TWO</w:t></w:r></w:p><w:p><w:moveFrom><w:r><w:t>MOVED-OLD</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>MOVED-NEW</w:t></w:r></w:moveTo></w:p></w:body></w:document>`),
    'word/footnotes.xml': strToU8(`<w:footnotes ${w}><w:footnote w:id="1"><w:p>${run('HEAD-NOTE')}</w:p></w:footnote><w:footnote w:id="2"><w:p>${run('BODY-NOTE')}</w:p></w:footnote></w:footnotes>`),
    'word/endnotes.xml': strToU8(`<w:endnotes ${w}><w:endnote w:id="3"><w:p>${run('END-NOTE')}</w:p></w:endnote></w:endnotes>`),
  })).toString('base64') };
  const notes = (await read(notesFile)).attachment;
  assert.equal(notes.pageCount, 2);
  assert.equal(notes.textContent.match(/BODY-NOTE/g).length, 1);
  assert.match(notes.textContent, /\[Footnotes\]\nHEAD-NOTE\nBODY-NOTE/);
  assert.match(notes.textContent, /\[Endnotes\]\nEND-NOTE/);
  assert.doesNotMatch(notes.textContent, /student-name|private\/path/);
  assert.match(notes.textContent, /SYMBOLS/);
  assert.ok(!notes.imageLimitations.some(limitation => limitation.reason === 'page-rendering-failed'));
  assert.match(notes.textContent, /PAGE-ONE\n[\s\S]*Page 1: visual content attached as an image\.\n\nPage 2\nPAGE-TWO/);
  assert.doesNotMatch(notes.textContent.slice(0, notes.textContent.indexOf('Page 2')), /PAGE-TWO/);
  assert.equal(notes.textContent.match(/MOVED-/g).length, 1);
  console.log('PASS: DOCX notes are listed once (header-row notes included), FILENAME fields are left out, invalid symbols are dropped, mid-paragraph page breaks start a new page, and moved text appears once.');

  const darkPixels = (file) => page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const [image] = (await readAttachment(file)).images;
    const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 100) dark++;
    return dark;
  }, { extensionId, file });
  const headerOnlyDocx = { name: 'header.docx', base64Data: Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document ${w}><w:body><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p>${run('ONLY HEADER ROW ANSWER')}</w:p></w:tc></w:tr></w:tbl></w:body></w:document>`) })).toString('base64') };
  const headerOnlyOdt = odtFile(`<table:table ${tableNamespaces}><table:table-header-rows><table:table-row><table:table-cell><text:p>ONLY HEADER ROW ANSWER</text:p></table:table-cell></table:table-row></table:table-header-rows></table:table>`);
  for (const file of [headerOnlyDocx, headerOnlyOdt]) assert.ok(await darkPixels(file) > 300, `${file.name}: a header-only table must be drawn`);
  console.log('PASS: DOCX and ODT tables made only of header rows are drawn on the page.');

  const titlePage = (await read({ name: 'title.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${w}><w:body><w:p>${run('COVER')}</w:p><w:p><w:r><w:lastRenderedPageBreak/><w:t>SECOND</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:titlePg/></w:sectPr></w:body></w:document>`),
    'word/header1.xml': strToU8(`<w:hdr ${w}><w:p>${run('STUDENT NAME')}</w:p></w:hdr>`),
    'word/_rels/document.xml.rels': strToU8(wordRels),
  })).toString('base64') })).attachment;
  assert.match(titlePage.textContent, /Page 2\n\[Header\]\nSTUDENT NAME\nSECOND/);
  assert.doesNotMatch(titlePage.textContent, /Page 1\n\[Header\]/);
  console.log('PASS: a DOCX header first shown after a different first page is listed on that page.');

  const linkRequests = [];
  const onLinkRequest = (request) => { if (request.url().includes('evil.invalid')) linkRequests.push(request.url()); };
  page.on('request', onLinkRequest);
  const linked = (await read({ name: 'linked.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${w} xmlns:wp="urn:wp" xmlns:a="urn:a" xmlns:pic="urn:pic"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:link="rIdRemote"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>${run('LINKED')}</w:p></w:body></w:document>`),
    'word/_rels/document.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdRemote" Type="image" Target="https://evil.invalid/remote.png" TargetMode="External"/></Relationships>'),
  })).toString('base64') })).attachment;
  page.off('request', onLinkRequest);
  assert.deepEqual(linked.imageLimitations, [{ reason: 'external-linked-image', format: 'link', count: 1 }]);
  assert.deepEqual(linkRequests, []);
  console.log('PASS: DOCX images linked outside the file are reported and never fetched.');

  // A single stale saved break must not turn the rest of a long document into one giant page.
  const stale = (await read(odtFile(`<text:p>Start</text:p><text:soft-page-break/>${Array.from({ length: 160 }, (_, index) => `<text:p>Paragraph ${index} of a long answer without any further saved page break.</text:p>`).join('')}`))).attachment;
  assert.ok(stale.pageCount >= 3, `pages ${stale.pageCount}`);
  console.log('PASS: stale or partial saved page breaks fall back to measured pagination.');

  const bomb = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    try { await readAttachment(file); return {}; } catch (error) { return { error: error.message }; }
  }, { extensionId, file: { name: 'bomb.docx', base64Data: Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document ${w}><w:body/></w:document>`), 'word/media/zeros.bin': new Uint8Array(49 * 1024 * 1024) })).toString('base64') } });
  assert.match(bomb.error || '', /DOCX exceeds the decompressed size limit/);
  const oversized = await read({ name: 'big.png', base64Data: Buffer.alloc(20 * 1024 * 1024 + 3).toString('base64') });
  assert.match(oversized.error || '', /Invalid or oversized attachment/);
  console.log('PASS: the reader refuses archives above 48 MB decompressed and files above 20 MB.');

  // Text a teacher could not see on the page is not sent: white on white, 1 pt, squeezed glyphs, off the page.
  // White text on a dark highlight and text on a dark page colour stay.
  const wordDocx = (body, extra = {}, documentAttributes = '') => ({ name: 'fictional.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${w}>${documentAttributes}<w:body>${body}</w:body></w:document>`), ...extra,
  })).toString('base64') });
  const invisibleDocx = (await read(wordDocx([
    `<w:p>${run('VISIBLE ANSWER')}${run(' WHITE SECRET', '<w:color w:val="FFFFFF"/>')}</w:p>`,
    `<w:p>${run('TINY SECRET', '<w:sz w:val="2"/>')}</w:p>`,
    `<w:p>${run('SQUEEZED SECRET', '<w:spacing w:val="-240"/>')}</w:p>`,
    `<w:p><w:pPr><w:ind w:left="-40000"/></w:pPr>${run('OFFPAGE SECRET')}</w:p>`,
    `<w:p>${run('PALE SECRET', '<w:color w:val="F4F4F4"/>')}</w:p>`,
    `<w:p>${run('WHITE ON NAVY', '<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:fill="000080"/>')}</w:p>`,
  ].join('')))).attachment;
  assert.match(invisibleDocx.textContent, /VISIBLE ANSWER/);
  assert.match(invisibleDocx.textContent, /WHITE ON NAVY/);
  assert.doesNotMatch(invisibleDocx.textContent, /SECRET/);
  assert.deepEqual(invisibleDocx.imageLimitations, [{ reason: 'invisible-text-excluded', format: 'docx', count: 5 }]);
  const darkPage = (await read(wordDocx(`<w:p>${run('LIGHT ON DARK PAGE', '<w:color w:val="FFFFFF"/>')}</w:p>`, {}, '<w:background w:color="202020"/>'))).attachment;
  assert.match(darkPage.textContent, /LIGHT ON DARK PAGE/);
  assert.deepEqual(darkPage.imageLimitations, []);
  const st = 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
  const invisibleOdt = (await read({ name: 'fictional.odt', base64Data: Buffer.from(zipSync({ 'content.xml': strToU8(`<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ${st}><office:automatic-styles>
    <style:style style:name="White" style:family="text"><style:text-properties fo:color="#ffffff"/></style:style>
    <style:style style:name="Tiny" style:family="paragraph"><style:text-properties fo:font-size="1pt"/></style:style>
    <style:style style:name="Marked" style:family="text"><style:text-properties fo:color="#ffffff" fo:background-color="#000000"/></style:style>
  </office:automatic-styles><office:body><office:text>
    <text:p>ODT ANSWER<text:span text:style-name="White"> WHITE SECRET</text:span></text:p>
    <text:p text:style-name="Tiny">TINY SECRET</text:p>
    <text:p><text:span text:style-name="Marked">WHITE ON BLACK</text:span></text:p>
  </office:text></office:body></office:document-content>`) })).toString('base64') })).attachment;
  assert.match(invisibleOdt.textContent, /ODT ANSWER/);
  assert.match(invisibleOdt.textContent, /WHITE ON BLACK/);
  assert.doesNotMatch(invisibleOdt.textContent, /SECRET/);
  assert.deepEqual(invisibleOdt.imageLimitations, [{ reason: 'invisible-text-excluded', format: 'odt', count: 2 }]);
  console.log('PASS: DOCX and ODT text drawn invisibly (background colour, tiny, squeezed, off the page) is left out and counted; contrasting text stays.');

  // pageImages 'visual': a page with only text has no image; a page with a table keeps it.
  const mixed = wordDocx(`<w:p>${run('PLAIN PROSE')}</w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr>${run('BEFORE TABLE')}</w:p><w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>${wordRow('CELL')}</w:tbl>`);
  const readMode = (file, pageImages) => page.evaluate(async ({ extensionId, file, pageImages }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const result = await readAttachment(file, { pageImages });
    return { ...result, images: result.images.map(({ pageNumber, part, parts }) => ({ pageNumber, part, parts })) };
  }, { extensionId, file, pageImages });
  const visualOnly = await readMode(mixed, 'visual');
  assert.equal(visualOnly.pageCount, 2);
  assert.deepEqual(visualOnly.images.map(image => image.pageNumber), [2]);
  assert.match(visualOnly.textContent, /Page 1\nPLAIN PROSE\n\nPage 1: text only \(no images, formulas, tables or drawings\); no page image attached\./);
  assert.match(visualOnly.textContent, /Page 2: visual content attached as an image\./);
  assert.deepEqual((await readMode(mixed, 'all')).images.map(image => image.pageNumber), [1, 2]);
  console.log('PASS: with page images limited to visual pages, a text-only DOCX page is sent as text and a page with a table keeps its image.');

  // A page far taller than its size (a table row with hundreds of lines, which cannot be split) is drawn in up to four parts.
  const tall = await readMode(odtFile(`<table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><table:table-column/><table:table-row><table:table-cell><text:p>${Array.from({ length: 400 }, (_, index) => `Line ${index}`).join('<text:line-break/>')}</text:p></table:table-cell></table:table-row></table:table>`), 'all');
  assert.equal(tall.pageCount, 1);
  assert.deepEqual(tall.images, [1, 2, 3, 4].map(part => ({ pageNumber: 1, part, parts: 4 })));
  assert.match(tall.textContent, /Page 1: visual content attached as 4 images, top to bottom\./);
  console.log('PASS: an oversized page is drawn as four legible parts, top to bottom.');
  const longParagraph = await readMode(odtFile(`<text:p>${Array.from({ length: 160 }, (_, index) => `Line ${index}`).join('<text:line-break/>')}</text:p>`), 'all');
  assert.ok(longParagraph.pageCount >= 3, `pages ${longParagraph.pageCount}`);
  assert.match(longParagraph.textContent, /^Page 1\nLine 0\n/);
  assert.match(longParagraph.textContent, /Line 159/);
  assert.ok(longParagraph.images.every(image => !image.parts));
  console.log('PASS: a paragraph longer than a page continues over several pages instead of stretching one.');

  // Requests from the service worker reuse a document already drawn with the same bytes and mode.
  const cache = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachmentCached } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const first = await readAttachmentCached(file, { pageImages: 'visual' });
    const started = performance.now();
    const second = await readAttachmentCached(file, { pageImages: 'visual' });
    const elapsed = performance.now() - started;
    const otherMode = await readAttachmentCached(file, { pageImages: 'all' });
    return { first: first.cached, second: second.cached, same: first.textContent === second.textContent, elapsed, otherMode: otherMode.cached };
  }, { extensionId, file: mixed });
  assert.deepEqual([cache.first, cache.second, cache.same, cache.otherMode], [undefined, true, true, undefined]);
  assert.ok(cache.elapsed < 200, `cached read took ${cache.elapsed} ms`);
  console.log('PASS: a second request for the same document and page-image mode reuses the drawn pages.');

  // Two w:num sharing an abstractNum continue one count (as LibreOffice shows them); a level override restarts it.
  const level = '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>';
  const sharedList = (await read(wordDocx(['SA', 'SB'].map(value => numbered(value, 0)).join('') + `<w:p>${run('BETWEEN')}</w:p>` +
    ['SC', 'SD'].map(value => numbered(value, 0).replace('w:numId w:val="1"', 'w:numId w:val="2"')).join('') +
    ['RA'].map(value => numbered(value, 0).replace('w:numId w:val="1"', 'w:numId w:val="3"')).join(''), {
    'word/numbering.xml': strToU8(`<w:numbering ${w}><w:abstractNum w:abstractNumId="0">${level}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>`),
  }))).attachment;
  assert.match(sharedList.textContent, /1\. SA\n2\. SB\nBETWEEN\n3\. SC\n4\. SD\n1\. RA/);
  console.log('PASS: DOCX lists sharing a definition continue their numbering, and a start override restarts it.');

  // Page geometry: each page image reduced to 10 px cells counting dark pixels and pixels near given colours.
  const inspect = (file, colors = []) => page.evaluate(async ({ extensionId, file, colors }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const result = await readAttachment(file);
    const pages = [];
    for (const image of result.images) {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
      const columns = Math.ceil(bitmap.width / 10);
      const rows = Math.ceil(bitmap.height / 10);
      const grid = () => Array.from({ length: rows }, () => new Array(columns).fill(0));
      const dark = grid();
      const tinted = colors.map(grid);
      for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
        const offset = (y * bitmap.width + x) * 4;
        const [r, g, b] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        if (r < 90 && g < 90 && b < 90) dark[Math.floor(y / 10)][Math.floor(x / 10)]++;
        colors.forEach(([cr, cg, cb], index) => { if (Math.abs(r - cr) < 16 && Math.abs(g - cg) < 16 && Math.abs(b - cb) < 16) tinted[index][Math.floor(y / 10)][Math.floor(x / 10)]++; });
      }
      pages.push({ columns, rows, dark, tinted });
      bitmap.close();
    }
    return { textContent: result.textContent, pageCount: result.pageCount, pages };
  }, { extensionId, file, colors });
  // Cells of a grid holding at least `minimum` matching pixels, as [row, column] pairs.
  const cellsOf = (grid, minimum = 20) => grid.flatMap((cells, row) => cells.flatMap((count, column) => count >= minimum ? [[row, column]] : []));
  const span = (cells, index) => [Math.min(...cells.map(cell => cell[index])), Math.max(...cells.map(cell => cell[index]))];
  const prose = (words) => Array.from({ length: words }, (_, index) => ['tide', 'harbour', 'lantern', 'survey', 'pier', 'ferry'][index % 6]).join(' ');
  const wordImageRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/picture.png"/></Relationships>';
  const anchored = (wrap, align, extra = '') => `<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="114300" distR="114300" behindDoc="0"><wp:positionH relativeFrom="column"><wp:align>${align}</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1371600" cy="914400"/>${wrap}<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData>${extra || '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdPic"/></pic:blipFill></pic:pic>'}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;

  // 1. Square wrapping: the picture floats right and the paragraph's text runs beside it; top-and-bottom keeps text above and below only.
  const wrapped = await inspect(wordDocx(`<w:p>${anchored('<wp:wrapSquare wrapText="bothSides"/>', 'right')}${run(prose(160))}</w:p><w:p>${anchored('<wp:wrapTopAndBottom/>', 'center').replace('rIdPic', 'rIdPic2')}${run('BELOW')}</w:p>`, {
    'word/_rels/document.xml.rels': strToU8(wordImageRels.replace('</Relationships>', '<Relationship Id="rIdPic2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/second.png"/></Relationships>')),
    'word/media/picture.png': solidPng(12, 8, [200, 30, 30]), 'word/media/second.png': solidPng(12, 8, [30, 30, 200]),
  }), [[200, 30, 30], [30, 30, 200]]);
  {
    const [sheet] = wrapped.pages;
    const red = cellsOf(sheet.tinted[0]);
    const [top, bottom] = span(red, 0);
    const [left, right] = span(red, 1);
    assert.ok(right > sheet.columns * 0.8 && left > sheet.columns * 0.6, `picture columns ${left}-${right}`);
    const beside = sheet.dark.slice(top + 1, bottom).filter(cells => cells.slice(0, left - 2).some(count => count > 3)).length;
    assert.ok(beside >= (bottom - top - 1) * 0.6, `text rows beside the picture: ${beside} of ${bottom - top - 1}`);
    const blue = cellsOf(sheet.tinted[1]);
    const [blueTop, blueBottom] = span(blue, 0);
    const [blueLeft, blueRight] = span(blue, 1);
    assert.ok(Math.abs((blueLeft + blueRight) / 2 - sheet.columns / 2) < 3, 'top-and-bottom picture is centred');
    assert.ok(sheet.dark.slice(blueTop + 1, blueBottom).every(cells => cells.slice(0, blueLeft - 1).concat(cells.slice(blueRight + 2)).every(count => count === 0)), 'no text beside a top-and-bottom picture');
    assert.match(wrapped.textContent, /tide harbour[\s\S]*BELOW/);
  }
  // A floating picture taller than the space left on the page moves to the next page with its paragraph, whole.
  const lateFloat = await inspect(wordDocx(`${Array.from({ length: 50 }, (_, index) => `<w:p>${run(`Filler line ${index}`)}</w:p>`).join('')}<w:p>${anchored('<wp:wrapSquare wrapText="bothSides"/>', 'right').replace('cy="914400"', 'cy="2743200"')}${run(prose(40))}</w:p>`, {
    'word/_rels/document.xml.rels': strToU8(wordImageRels), 'word/media/picture.png': solidPng(6, 12, [200, 30, 30]),
  }), [[200, 30, 30]]);
  assert.equal(lateFloat.pageCount, 2);
  assert.equal(cellsOf(lateFloat.pages[0].tinted[0]).length, 0, 'no part of the picture on page 1');
  assert.ok(span(cellsOf(lateFloat.pages[1].tinted[0]), 0)[1] - span(cellsOf(lateFloat.pages[1].tinted[0]), 0)[0] >= 38, 'the whole 3-inch picture on page 2');
  console.log('PASS: DOCX anchored pictures with square wrapping float beside the text; top-and-bottom wrapping keeps a centred block; a float taller than the space left moves whole to the next page.');

  // 2. DOCX text box fill and outline (wps:spPr solidFill and a:ln); its text keeps the box, not the justified paragraph.
  const wordBox = `<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:spPr><a:solidFill><a:srgbClr val="20C020"/></a:solidFill><a:ln w="38100"><a:solidFill><a:srgbClr val="2020C0"/></a:solidFill></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p>${run('BOXED NOTE')}</w:p></w:txbxContent></wps:txbx><wps:bodyPr lIns="91440" tIns="45720" rIns="91440" bIns="45720"/></wps:wsp>`;
  const boxed = await inspect(wordDocx(`<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${anchored('<wp:wrapSquare wrapText="bothSides"/>', 'left', wordBox)}${run(prose(80))}</w:p>`), [[32, 192, 32], [32, 32, 192]]);
  {
    const [sheet] = boxed.pages;
    const green = cellsOf(sheet.tinted[0], 60);
    assert.ok(green.length > 50, `filled cells ${green.length}`);
    assert.ok(span(green, 1)[1] < sheet.columns * 0.5, 'the box floats left');
    assert.ok(cellsOf(sheet.tinted[1], 5).length > 30, 'outline drawn in its colour');
    assert.match(boxed.textContent, /BOXED NOTE/);
  }
  console.log('PASS: DOCX text boxes draw their fill and outline colours and float with square wrapping.');

  // 3. ODT: a parallel-wrapped picture floats left, a text frame draws draw:fill-color and svg:stroke-color,
  // and centre and right tab stops place the parts of a line.
  const odtLayoutNamespaces = `${odtNamespaces} xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"`;
  const odtGeometry = (styles, body, extra = {}) => ({ name: 'fictional.odt', base64Data: Buffer.from(zipSync({
    'content.xml': strToU8(`<office:document-content ${odtLayoutNamespaces}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`), ...extra,
  })).toString('base64') });
  const odtFrames = await inspect(odtGeometry(`
    <style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="parallel" style:horizontal-pos="left" fo:margin-right="0.3cm"/></style:style>
    <style:style style:name="fr2" style:family="graphic"><style:graphic-properties style:wrap="none" style:horizontal-pos="center" draw:fill="solid" draw:fill-color="#20c020" draw:stroke="solid" svg:stroke-color="#2020c0" svg:stroke-width="0.1cm"/></style:style>
    <style:style style:name="Tabs" style:family="paragraph"><style:paragraph-properties><style:tab-stops><style:tab-stop style:position="8.5cm" style:type="center"/><style:tab-stop style:position="17cm" style:type="right"/></style:tab-stops></style:paragraph-properties></style:style>`,
  `<text:p text:style-name="Tabs">LEFTPART<text:tab/>MIDDLE<text:tab/>RIGHTPART</text:p>
   <text:p><draw:frame draw:style-name="fr1" text:anchor-type="paragraph" svg:width="4cm" svg:height="3cm"><draw:image xlink:href="Pictures/picture.png"/></draw:frame>${prose(160)}</text:p>
   <text:p><draw:frame draw:style-name="fr2" text:anchor-type="paragraph" svg:width="10cm" svg:height="2cm"><draw:text-box><text:p>FRAMED TEXT</text:p></draw:text-box></draw:frame></text:p>`,
  { 'Pictures/picture.png': solidPng(12, 8, [200, 30, 30]) }), [[200, 30, 30], [32, 192, 32], [32, 32, 192]]);
  {
    const [sheet] = odtFrames.pages;
    const red = cellsOf(sheet.tinted[0]);
    const [top, bottom] = span(red, 0);
    const [left, right] = span(red, 1);
    assert.ok(left < sheet.columns * 0.15 && right < sheet.columns * 0.4, `picture columns ${left}-${right}`);
    const beside = sheet.dark.slice(top + 1, bottom).filter(cells => cells.slice(right + 2).some(count => count > 3)).length;
    assert.ok(beside >= (bottom - top - 1) * 0.6, `text rows beside the picture: ${beside} of ${bottom - top - 1}`);
    assert.ok(cellsOf(sheet.tinted[1], 60).length > 50, 'frame fill drawn');
    assert.ok(cellsOf(sheet.tinted[2], 5).length > 30, 'frame outline drawn');
    // The tabbed line: ink near the centre of the text area (10.5 cm) and ending at the right margin (19 cm).
    const tabbed = sheet.dark.findIndex(cells => cells.some(count => count > 3));
    const line = sheet.dark.slice(tabbed, tabbed + 2).reduce((sum, cells) => sum.map((value, index) => value + cells[index]), new Array(sheet.columns).fill(0));
    const inked = line.flatMap((count, column) => count > 3 ? [column] : []);
    const centre = Math.round(sheet.columns * 10.5 / 21);
    const margin = Math.round(sheet.columns * 19 / 21);
    assert.ok(inked.some(column => Math.abs(column - centre) <= 2), 'centred segment');
    assert.ok(Math.abs(Math.max(...inked) - margin) <= 2, `right segment ends at ${Math.max(...inked)}, margin ${margin}`);
    assert.ok(!inked.some(column => column > centre + 8 && column < margin - 20), 'gap between centre and right segments');
    assert.match(odtFrames.textContent, /LEFTPART\tMIDDLE\tRIGHTPART[\s\S]*FRAMED TEXT/);
  }
  console.log('PASS: ODT frames float with parallel wrapping, text frames draw their fill and outline, and centre and right tab stops place their text.');

  // 4. Multi-column sections (DOCX w:cols, ODT text:section with style:columns) draw two columns; long ones continue on the next page without losing text.
  const columnText = (count) => Array.from({ length: count }, (_, index) => `Column paragraph ${index + 1} ${prose(30)}`);
  const docxColumns = (count) => wordDocx(`<w:p>${run('BEFORE COLUMNS')}</w:p><w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr></w:p>${columnText(count).map(text => `<w:p>${run(text)}</w:p>`).join('')}<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/><w:cols w:num="2" w:space="720"/></w:sectPr></w:pPr></w:p><w:p>${run('AFTER COLUMNS')}</w:p><w:sectPr><w:type w:val="continuous"/></w:sectPr>`);
  const odtColumns = (count) => odtGeometry('<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="1cm"/></style:section-properties></style:style>',
    `<text:p>BEFORE COLUMNS</text:p><text:section text:style-name="Sect1" text:name="Two">${columnText(count).map(text => `<text:p>${text}</text:p>`).join('')}</text:section><text:p>AFTER COLUMNS</text:p>`);
  for (const [format, file] of [['DOCX', docxColumns(8)], ['ODT', odtColumns(8)]]) {
    const result = await inspect(file);
    const [sheet] = result.pages;
    const middle = Math.round(sheet.columns / 2);
    const rows = sheet.dark.filter(cells => cells.slice(0, middle - 3).some(count => count > 3) && cells.slice(middle + 3).some(count => count > 3));
    assert.ok(rows.length > 15, `${format}: rows with text in both halves ${rows.length}`);
    assert.ok(rows.filter(cells => cells[middle] === 0 && cells[middle - 1] === 0).length >= rows.length * 0.9, `${format}: a gap between the columns`);
    assert.match(result.textContent, /BEFORE COLUMNS[\s\S]*Column paragraph 8[\s\S]*AFTER COLUMNS/);
  }
  for (const file of [docxColumns(120), odtColumns(120)]) {
    const result = await read(file);
    assert.ok(result.attachment.pageCount >= 2, `pages ${result.attachment.pageCount}`);
    for (const index of [1, 60, 120]) assert.match(result.attachment.textContent, new RegExp(`Column paragraph ${index} `));
  }
  console.log('PASS: DOCX and ODT multi-column sections are drawn in two columns and long ones continue on the next pages with all their text.');

  await checkSpreadsheetsAndPresentations(page, extensionId, read);
}

// Spreadsheets and presentations: fictional XLSX, ODS, PPTX and ODP files built in memory.
async function checkSpreadsheetsAndPresentations(page, extensionId, read) {
  // Reads a file and counts colours in its page images.
  const readPixels = (file, options = {}) => page.evaluate(async ({ extensionId, file, options }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const started = performance.now();
    let result;
    try { result = await readAttachment(file, options); } catch (error) { return { error: error.message, code: error.code, elapsed: performance.now() - started }; }
    const elapsed = performance.now() - started;
    const pages = [];
    for (const image of result.images) {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
      const counts = { width: bitmap.width, height: bitmap.height, red: 0, yellow: 0, dark: 0, topLeftDark: 0, navy: 0 };
      for (let index = 0; index < pixels.length; index += 4) {
        const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]];
        if (r > 180 && g < 60 && b < 60) counts.red++;
        if (r > 230 && g > 230 && b < 40) counts.yellow++;
        if (r < 60 && g < 60 && b < 60) {
          counts.dark++;
          const pixel = index / 4;
          if (pixel % bitmap.width < bitmap.width / 2 && pixel / bitmap.width < bitmap.height / 4) counts.topLeftDark++;
        }
        if (r < 20 && g < 20 && b > 100 && b < 160) counts.navy++;
      }
      pages.push(counts);
      bitmap.close();
    }
    return { ...result, images: result.images.map(({ pageNumber, mimeType }) => ({ pageNumber, mimeType })), pages, elapsed };
  }, { extensionId, file, options });

  const xlsx = await readPixels(xlsxFile());
  assert.equal(xlsx.documentFormat, 'xlsx');
  assert.equal(xlsx.pageCount, 1);
  assert.equal(xlsx.textContent, [
    'Page 1', '[Sheet: Grades]', 'A1: Name\tB1: Score', 'A2: Ana García\tB2: 7.50\tC2: 15 (=B2*2)', '[Comment B2: Check the rounding]',
    'A3: Total\tB3: 7.5 (=SUM(B2:B2))\tC3: 15 (=B3*2)', 'A4: 12.5%\tB4: 2026-10-28\tC4: TRUE', 'A6 (merged A6:C6): MERGED TITLE', '',
    'Page 1: visual content attached as an image.',
  ].join('\n'));
  assert.deepEqual(xlsx.imageLimitations, [
    { reason: 'unsupported-embedded-object', format: 'chart', count: 1 }, { reason: 'hidden-text-excluded', format: 'xlsx', count: 3 },
    { reason: 'invisible-text-excluded', format: 'xlsx', count: 1 },
  ]);
  // Landscape A4 at the PDF page resolution, with the anchored picture and the merged cell's fill.
  assert.equal(xlsx.pages[0].width, 1685);
  assert.ok(Math.abs(xlsx.pages[0].height - 1191) <= 2, `sheet page height ${xlsx.pages[0].height}`);
  assert.ok(xlsx.pages[0].red > 5000, 'the anchored picture must be drawn');
  assert.ok(xlsx.pages[0].yellow > 2000, 'the merged cell fill must be drawn');
  assert.doesNotMatch(xlsx.textContent, /HIDDEN|WHITE SECRET|Student/);
  console.log('PASS: XLSX sheets become landscape pages with cell references, cached values with their number formats, formulas (shared ones moved), merged cells, comments and pictures; hidden sheets, rows and columns and white text are left out and counted.');

  const xlsxFallback = await page.evaluate(async ({ extensionId, file }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const originalSerialize = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = () => { throw new Error('Fictional rendering failure'); };
    try { return await readAttachment(file); }
    finally { XMLSerializer.prototype.serializeToString = originalSerialize; }
  }, { extensionId, file: xlsxFile() });
  assert.match(xlsxFallback.textContent, /^\[Sheet: Grades\]\nA1: Name\tB1: Score\n/);
  assert.equal(xlsxFallback.pageCount, undefined);
  assert.deepEqual(xlsxFallback.imageLimitations.map(limitation => limitation.reason), ['unsupported-embedded-object', 'hidden-text-excluded', 'page-rendering-failed']);
  assert.equal(xlsxFallback.images.length, 1);
  console.log('PASS: an XLSX page-rendering failure keeps the cell text and embedded images and reports the missing page images.');

  // ODS: repeated rows and columns, a formula with a comment, a merged cell, a hidden row and sheet, and a
  // million trailing empty rows that are trimmed instead of drawn.
  const odsStyles = '<style:style style:name="hidden" style:family="table"><style:table-properties table:display="false"/></style:style><style:style style:name="head" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffff00"/><style:text-properties fo:font-weight="bold"/></style:style>';
  const ods = await readPixels(odsFile(`<table:table table:name="Data"><table:table-column table:number-columns-repeated="16384"/>
    <table:table-row>${odsCell('Item', 'table:style-name="head"')}${odsCell('Qty', 'table:style-name="head"')}<table:table-cell table:number-columns-repeated="16382"/></table:table-row>
    <table:table-row table:number-rows-repeated="2">${odsCell('Pen')}${odsNumber(3, '3')}<table:table-cell table:number-columns-repeated="16382"/></table:table-row>
    <table:table-row>${odsCell('Sum')}<table:table-cell table:formula="of:=SUM([.B2:.B3])" office:value-type="float" office:value="6"><text:p>6</text:p><office:annotation><dc:creator>Fictional</dc:creator><text:p>Check this</text:p></office:annotation></table:table-cell></table:table-row>
    <table:table-row table:visibility="collapse">${odsCell('HIDDEN ODS ROW')}</table:table-row>
    <table:table-row>${odsCell('Merged', 'table:number-columns-spanned="2"')}<table:covered-table-cell/></table:table-row>
    <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>
    <table:table table:name="Hidden" table:style-name="hidden"><table:table-row>${odsCell('HIDDEN ODS SHEET')}</table:table-row></table:table>`, odsStyles));
  assert.equal(ods.textContent, [
    'Page 1', '[Sheet: Data]', 'A1: Item\tB1: Qty', 'A2: Pen\tB2: 3', 'A3: Pen\tB3: 3', 'A4: Sum\tB4: 6 (=SUM(B2:B3))', '[Comment B4: Check this]',
    'A6 (merged A6:B6): Merged', '', 'Page 1: visual content attached as an image.',
  ].join('\n'));
  assert.deepEqual(ods.imageLimitations, [{ reason: 'hidden-text-excluded', format: 'ods', count: 2 }]);
  assert.ok(ods.pages[0].yellow > 1000, 'cell styles must be drawn');
  assert.ok(ods.elapsed < 15000, `trailing repeated rows took ${ods.elapsed} ms`);
  const odsBomb = await readPixels(odsFile(`<table:table table:name="Bomb"><table:table-row table:number-rows-repeated="1048576">${odsCell('x', 'table:number-columns-repeated="16384"')}</table:table-row></table:table>`));
  assert.equal(odsBomb.code, 'PAGE_LIMIT');
  assert.match(odsBomb.error, /ODS exceeds the 10,000 non-empty cell limit/);
  assert.ok(odsBomb.elapsed < 5000, `repeated content took ${odsBomb.elapsed} ms`);
  console.log('PASS: ODS repeated rows and columns are expanded only where they hold content, trailing empty repeats are trimmed, and a repeated-content bomb stops at the cell budget.');

  // PPTX: title and body placeholders take their position and text style from the layout and master.
  const tableData = '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>' +
    [['Plant', 'Growth'], ['Fern', '4 cm']].map(row => `<a:tr h="500000">${row.map(cell => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`).join('') + '</a:tbl></a:graphicData>';
  const pptx = await readPixels(pptxFile([
    { shapes: [
      pptxShape({ id: 2, ph: '<p:ph type="title"/>', paragraphs: [pptxRun('Photosynthesis')] }),
      pptxShape({ id: 3, ph: '<p:ph idx="1"/>', paragraphs: [pptxRun('Light reactions'), pptxRun('Calvin cycle')] }),
      pptxPicture(4, 'rIdDark', [7000000, 4500000, 3000000, 1500000]),
      pptxShape({ id: 5, box: [7100000, 4700000, 2800000, 800000], paragraphs: [pptxRun('ON PHOTO', { color: 'FFFFFF' })] }),
      pptxShape({ id: 6, box: [838200, 5000000, 3000000, 600000], paragraphs: [pptxRun('WHITE SECRET', { color: 'FFFFFF' })] }),
      pptxShape({ id: 7, box: [4000000, 5000000, 2500000, 600000], fill: '<a:solidFill><a:srgbClr val="000080"/></a:solidFill>', paragraphs: [pptxRun('WHITE ON NAVY', { color: 'FFFFFF' })] }),
    ].join(''), images: { rIdDark: solidPng(30, 15, [20, 20, 20]) }, notes: 'Mention chlorophyll' },
    { hidden: true, shapes: pptxShape({ id: 2, box: [0, 0, 5000000, 1000000], paragraphs: [pptxRun('HIDDEN SLIDE TEXT')] }) },
    { shapes: [
      pptxShape({ id: 2, ph: '<p:ph type="title"/>', paragraphs: [pptxRun('Results')] }),
      pptxFrame(3, [838200, 1825625, 6000000, 1000000], tableData),
      pptxFrame(4, [7500000, 1825625, 3000000, 2000000], '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData>'),
    ].join('') },
  ]));
  assert.equal(pptx.documentFormat, 'pptx');
  assert.equal(pptx.pageCount, 2);
  const [slideOne, slideThree] = pptx.textPages.map(item => pptx.textContent.slice(item.start, item.end));
  assert.equal(slideOne, 'Page 1\n[Slide 1]\nPhotosynthesis\n• Light reactions\n• Calvin cycle\nON PHOTO\nWHITE ON NAVY\n[Speaker notes]\nMention chlorophyll\n\nPage 1: visual content attached as an image.');
  assert.equal(slideThree, '\n\nPage 2\n[Slide 3]\nResults\nPlant\tGrowth\nFern\t4 cm\n\nPage 2: visual content attached as an image.');
  assert.deepEqual(pptx.imageLimitations, [
    { reason: 'unsupported-embedded-object', format: 'chart', count: 1 }, { reason: 'hidden-text-excluded', format: 'pptx', count: 1 },
    { reason: 'invisible-text-excluded', format: 'pptx', count: 1 },
  ]);
  // 16:9 slides at 1.5 times their size; the master places the title at the top left.
  assert.deepEqual([pptx.pages[0].width, pptx.pages[0].height], [1920, 1080]);
  assert.ok(pptx.pages[0].topLeftDark > 1500, 'the inherited title must be drawn at the master position');
  assert.ok(pptx.pages[0].dark > 50000, 'the picture must be drawn');
  assert.ok(pptx.pages[0].navy > 10000, 'the shape fill must be drawn');
  console.log('PASS: PPTX slides are drawn at their size with placeholders inherited from the layout and master, pictures, fills and tables; white text over a dark picture stays, white text on the white slide is left out, hidden slides are left out and speaker notes are listed.');

  const textSlide = await readPixels(pptxFile([{ shapes: pptxShape({ id: 2, ph: '<p:ph type="title"/>', paragraphs: [pptxRun('Only words')] }) }]), { pageImages: 'visual' });
  assert.deepEqual(textSlide.images, []);
  assert.match(textSlide.textContent, /Page 1: text only/);
  console.log('PASS: with page images limited to visual pages, a slide with only text is sent as text.');

  const odpStyles = '<style:style style:name="hidden" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style><style:style style:name="blue" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#2a6099" draw:stroke="none" draw:textarea-vertical-align="middle"/><style:text-properties fo:color="#ffffff" fo:font-size="24pt"/></style:style><text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="●"/></text:list-style>';
  const odp = await readPixels(odpFile(`<draw:page draw:name="One" draw:master-page-name="Default">
      <draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>ODP TITLE</text:p></draw:text-box></draw:frame>
      <draw:frame presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="12cm" svg:height="8cm"><draw:text-box><text:list text:style-name="L1"><text:list-item><text:p>First point</text:p></text:list-item><text:list-item><text:p>Second point</text:p></text:list-item></text:list></draw:text-box></draw:frame>
      <draw:custom-shape draw:style-name="blue" svg:x="16cm" svg:y="6cm" svg:width="8cm" svg:height="4cm"><text:p>IN SHAPE</text:p><draw:enhanced-geometry draw:type="ellipse"/></draw:custom-shape>
      <presentation:notes><draw:frame presentation:class="notes" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="5cm"><draw:text-box><text:p>ODP speaker note</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>
    <draw:page draw:name="Two" draw:style-name="hidden" draw:master-page-name="Default"><draw:frame svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>HIDDEN ODP SLIDE</text:p></draw:text-box></draw:frame></draw:page>`, odpStyles));
  assert.equal(odp.textContent, 'Page 1\n[Slide 1]\nODP TITLE\n● First point\n● Second point\nIN SHAPE\n[Speaker notes]\nODP speaker note\n\nPage 1: visual content attached as an image.');
  assert.deepEqual(odp.imageLimitations, [{ reason: 'hidden-text-excluded', format: 'odp', count: 1 }]);
  assert.ok(Math.abs(odp.pages[0].width - 1587) <= 2 && Math.abs(odp.pages[0].height - 893) <= 2, `ODP page ${odp.pages[0].width}x${odp.pages[0].height}`);
  console.log('PASS: ODP slides are drawn at the master page size with frames, lists and filled shapes; hidden slides are left out and speaker notes are listed.');

  // Legacy binary spreadsheets and presentations stay unsupported.
  const legacySheet = await read({ name: 'old.xls', base64Data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).toString('base64') });
  assert.match(legacySheet.error || '', /Legacy Office binary/);
  console.log('PASS: legacy XLS and PPT files remain unsupported.');
}
