// Fictional spreadsheets (XLSX, ODS) and presentations (PPTX, ODP) built in memory.
import { strToU8, zipSync, zlibSync } from 'fflate';

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
// A solid-colour RGB PNG.
export const solidPng = (width, height, [r, g, b]) => {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())]);
};
const pack = (name, files) => ({ name, base64Data: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, typeof data === 'string' ? strToU8(data) : data])))).toString('base64') });
const rels = (items) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const types = (overrides) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${Object.entries(overrides).map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`;
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

// Grades sheet: shared and rich strings, number formats, a shared formula, a merged cell,
// a comment, a picture, white text, a hidden row and column, and a hidden sheet.
export const xlsxFile = ({ extraRows = '', hiddenSheet = true } = {}) => pack('grades.xlsx', {
  '[Content_Types].xml': types({ 'xl/workbook.xml': 'spreadsheetml.sheet.main', 'xl/worksheets/sheet1.xml': 'spreadsheetml.worksheet', 'xl/worksheets/sheet2.xml': 'spreadsheetml.worksheet',
    'xl/sharedStrings.xml': 'spreadsheetml.sharedStrings', 'xl/styles.xml': 'spreadsheetml.styles', 'xl/comments1.xml': 'spreadsheetml.comments', 'xl/drawings/drawing1.xml': 'drawing' }),
  '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
  'xl/workbook.xml': `<workbook ${S}><sheets><sheet name="Grades" sheetId="1" r:id="rId1"/>${hiddenSheet ? '<sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/>' : ''}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml'], ['rId4', 'styles', 'styles.xml']]),
  'xl/sharedStrings.xml': `<sst ${S}><si><t>Name</t></si><si><t>Score</t></si><si><r><t xml:space="preserve">Ana </t></r><r><rPr><b/><sz val="11"/><color rgb="FFC00000"/><rFont val="Calibri"/></rPr><t>García</t></r></si><si><t>MERGED TITLE</t></si></sst>`,
  'xl/styles.xml': `<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
    <fonts><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
    <fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
    <borders><border/><border><bottom style="medium"><color rgb="FF0000FF"/></bottom></border></borders>
    <cellXfs><xf/><xf fontId="1" borderId="1"/><xf numFmtId="164"/><xf numFmtId="14"/><xf fillId="2"><alignment horizontal="center"/></xf><xf fontId="2"/><xf numFmtId="2"/><xf numFmtId="0"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<worksheet ${S}><cols><col min="2" max="2" width="20" customWidth="1"/><col min="4" max="4" width="9" hidden="1"/></cols><sheetData>
    <row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c><c r="D1" t="inlineStr"><is><t>HIDDEN COLUMN</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="6"><v>7.5</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">B2*2</f><v>15</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>7.5</v></c><c r="C3"><f t="shared" si="0"/><v>15</v></c></row>
    <row r="4"><c r="A4" s="2"><v>0.125</v></c><c r="B4" s="3"><v>46323</v></c><c r="C4" t="b"><v>1</v></c></row>
    <row r="5" hidden="1"><c r="A5" t="inlineStr"><is><t>HIDDEN ROW</t></is></c></row>
    <row r="6"><c r="A6" t="s" s="4"><v>3</v></c><c r="B6" s="4"/><c r="C6" s="4"/></row>
    <row r="7"><c r="A7" t="inlineStr" s="5"><is><t>WHITE SECRET</t></is></c></row>${extraRows}
  </sheetData><mergeCells count="1"><mergeCell ref="A6:C6"/></mergeCells><drawing r:id="rId2"/></worksheet>`,
  'xl/worksheets/_rels/sheet1.xml.rels': rels([['rId1', 'comments', '../comments1.xml'], ['rId2', 'drawing', '../drawings/drawing1.xml']]),
  'xl/comments1.xml': `<comments ${S}><authors><author>Student</author></authors><commentList><comment ref="B2" authorId="0"><text><r><rPr><b/></rPr><t>Student:</t></r><r><t xml:space="preserve">
Check the rounding</t></r></text></comment></commentList></comments>`,
  'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ${A} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
      <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>
    <xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1905000" cy="952500"/>
      <xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>
  </xdr:wsDr>`,
  'xl/drawings/_rels/drawing1.xml.rels': rels([['rId1', 'image', '../media/image1.png']]),
  'xl/media/image1.png': solidPng(40, 40, [220, 20, 20]),
  'xl/worksheets/sheet2.xml': `<worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN SHEET</t></is></c></row></sheetData></worksheet>`,
});

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:dc="http://purl.org/dc/elements/1.1/"';
export const odsFile = (tables, automaticStyles = '') => pack('fictional.ods', {
  mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
  'content.xml': `<office:document-content ${ODF}><office:automatic-styles>${automaticStyles}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
});
export const odsCell = (text, attributes = '') => `<table:table-cell office:value-type="string"${attributes ? ` ${attributes}` : ''}><text:p>${text}</text:p></table:table-cell>`;
export const odsNumber = (value, text, attributes = '') => `<table:table-cell office:value-type="float" office:value="${value}"${attributes ? ` ${attributes}` : ''}><text:p>${text}</text:p></table:table-cell>`;

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const nv = (id, name, ph = '') => `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`;
const xfrm = (x, y, cx, cy) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const body = (paragraphs) => `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.map(paragraph => `<a:p>${paragraph}</a:p>`).join('')}</p:txBody>`;
// A text run; color is a hex colour, attributes are rPr attributes such as ' sz="400"'.
export const pptxRun = (text, { color = '', attributes = '' } = {}) => `<a:r><a:rPr lang="en-US"${attributes}>${color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ''}</a:rPr><a:t>${text}</a:t></a:r>`;
export const pptxShape = ({ id, name = `Shape ${id}`, ph = '', box = null, fill = '', paragraphs }) =>
  `<p:sp>${nv(id, name, ph)}<p:spPr>${box ? xfrm(...box) : ''}${box ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : ''}${fill}</p:spPr>${body(paragraphs)}</p:sp>`;
const tree = (shapes) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;
// Slides are { shapes, hidden, notes, images: { rId: png } }.
export const pptxFile = (slides) => {
  const files = {
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation ${P} ${A}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdS${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, index) => [`rIdS${index + 1}`, 'slide', `slides/slide${index + 1}.xml`])]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${P} ${A}>${tree(
      pptxShape({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', box: [838200, 365125, 10515600, 1325563], paragraphs: [] }) +
      pptxShape({ id: 3, name: 'Body', ph: '<p:ph type="body" idx="1"/>', box: [838200, 1825625, 10515600, 4351338], paragraphs: [] }))}
      <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
      <p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
      <p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>
      <p:otherStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${P} ${A}>${tree(
      pptxShape({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', paragraphs: [] }) + pptxShape({ id: 3, name: 'Content', ph: '<p:ph idx="1"/>', paragraphs: [] }))}</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': `<a:theme ${A} name="Fictional"><a:themeElements><a:clrScheme name="Fictional"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fictional"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
  };
  files['[Content_Types].xml'] = types({ 'ppt/presentation.xml': 'presentationml.presentation.main', 'ppt/slideMasters/slideMaster1.xml': 'presentationml.slideMaster',
    'ppt/slideLayouts/slideLayout1.xml': 'presentationml.slideLayout', 'ppt/theme/theme1.xml': 'theme',
    ...Object.fromEntries(slides.flatMap((slide, index) => [[`ppt/slides/slide${index + 1}.xml`, 'presentationml.slide'], ...(slide.notes ? [[`ppt/notesSlides/notesSlide${index + 1}.xml`, 'presentationml.notesSlide']] : [])])) });
  slides.forEach((slide, index) => {
    const number = index + 1;
    files[`ppt/slides/slide${number}.xml`] = `<p:sld ${P} ${A}${slide.hidden ? ' show="0"' : ''}>${tree(slide.shapes)}</p:sld>`;
    const slideRels = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    for (const [id, png] of Object.entries(slide.images || {})) {
      slideRels.push([id, 'image', `../media/slide${number}-${id}.png`]);
      files[`ppt/media/slide${number}-${id}.png`] = png;
    }
    if (slide.notes) {
      slideRels.push(['rIdNotes', 'notesSlide', `../notesSlides/notesSlide${number}.xml`]);
      files[`ppt/notesSlides/notesSlide${number}.xml`] = `<p:notes ${P} ${A}>${tree(pptxShape({ id: 2, name: 'Notes', ph: '<p:ph type="body" idx="1"/>', paragraphs: [pptxRun(slide.notes)] }))}</p:notes>`;
    }
    files[`ppt/slides/_rels/slide${number}.xml.rels`] = rels(slideRels);
  });
  return pack('fictional.pptx', files);
};
export const pptxPicture = (id, embed, box) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(...box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
export const pptxFrame = (id, box, data) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></p:xfrm><a:graphic>${data}</a:graphic></p:graphicFrame>`;

export const odpFile = (pages, automaticStyles = '') => pack('fictional.odp', {
  mimetype: 'application/vnd.oasis.opendocument.presentation',
  'styles.xml': `<office:document-styles ${ODF}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`,
  'content.xml': `<office:document-content ${ODF}><office:automatic-styles>${automaticStyles}</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`,
});
