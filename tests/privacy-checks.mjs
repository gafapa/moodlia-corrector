// Chromium checks for the student-name cover on page images and for text hidden under pictures.
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { makePdf } from './fixtures/pdf.mjs';
import { pptxFile, pptxPicture, pptxRun, pptxShape, solidPng } from './fixtures/office-models.mjs';

const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const run = (value) => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;

export async function checkStudentPrivacy(page, extensionId) {
  // Reads a file and counts near-black pixels on its page images.
  const read = (file, options) => page.evaluate(async ({ extensionId, file, options }) => {
    const { readAttachment } = await import(`chrome-extension://${extensionId}/src/attachments/reader.js`);
    const started = performance.now();
    const result = await readAttachment(file, options);
    const elapsed = performance.now() - started;
    let dark = 0;
    for (const image of result.images || []) {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64Data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 40 && pixels[index + 1] < 40 && pixels[index + 2] < 40) dark++;
      bitmap.close();
    }
    return { ...result, images: (result.images || []).length, dark, elapsed };
  }, { extensionId, file, options });

  const docx = { name: 'essay.docx', base64Data: Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${w}><w:body><w:p>${run('Autora: Lucía del Río Fernández')}</w:p><w:p>${run('Ensayo sobre la luna y el río. LUCÍA DEL RÍO FERNÁNDEZ firma al final.')}</w:p>
      <w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p>${run('Tabla')}</w:p></w:tc></w:tr></w:tbl></w:body></w:document>`),
  })).toString('base64') };
  const plain = await read(docx, { pageImages: 'all' });
  const covered = await read(docx, { pageImages: 'all', studentName: 'Lucía del Río Fernández' });
  assert.equal(plain.redactions, undefined);
  assert.equal(covered.redactions, 2);
  assert.ok(covered.dark > plain.dark + 2000, `dark pixels ${plain.dark} -> ${covered.dark}`);
  // The reader covers the images only; the service worker replaces the name in the text.
  assert.match(covered.textContent, /Lucía del Río Fernández/);
  assert.match(covered.textContent, /la luna y el río/);
  console.log(`PASS: the student's name is covered on DOCX page images, in any case (${Math.round(covered.elapsed)} ms with the cover, ${Math.round(plain.elapsed)} ms without).`);

  const pdf = { name: 'evidence.pdf', base64Data: Buffer.from(makePdf(true, 1)).toString('base64') };
  const pdfPlain = await read(pdf, {});
  const pdfCovered = await read(pdf, { studentName: 'Fictional Student' });
  assert.equal(pdfCovered.redactions, 1);
  assert.ok(pdfCovered.dark > pdfPlain.dark + 500, `dark pixels ${pdfPlain.dark} -> ${pdfCovered.dark}`);
  console.log('PASS: the student\'s name is covered on PDF page images from the text positions.');

  // A picture placed over a text box hides that text: it is left out and counted. A picture
  // behind the text (earlier in the slide) keeps it.
  const box = [1000000, 1000000, 4000000, 1000000];
  const slide = (shapes) => ({ shapes, images: { rIdPhoto: solidPng(40, 20, [30, 90, 160]) } });
  const textBox = pptxShape({ id: 4, box, paragraphs: [pptxRun('UNDER THE PHOTO')] });
  const coveredSlide = await read(pptxFile([slide(textBox + pptxPicture(5, 'rIdPhoto', box))]), { pageImages: 'all' });
  assert.doesNotMatch(coveredSlide.textContent, /UNDER THE PHOTO/);
  assert.ok(coveredSlide.imageLimitations.some(entry => entry.reason === 'invisible-text-excluded'), JSON.stringify(coveredSlide.imageLimitations));
  const behindSlide = await read(pptxFile([slide(pptxPicture(5, 'rIdPhoto', box) + pptxShape({ id: 4, box, paragraphs: [pptxRun('OVER THE PHOTO', { color: 'FFFFFF' })] }))]), { pageImages: 'all' });
  assert.match(behindSlide.textContent, /OVER THE PHOTO/);
  console.log('PASS: text covered by a picture drawn over it is left out; text drawn over a picture stays.');
}
