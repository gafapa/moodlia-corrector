# DOCX and ODT page rendering

From 0.2.1, DOCX and ODT files reach the model the same way as PDFs: each
page's text beside a rendered image of that page. Before 0.2.1 they arrived as
one block of text plus their embedded images. The model could not see headings,
tables, list numbering, equations, colours, headers and footers, or where an
image sat in the answer.

Spreadsheets (XLSX, ODS) and presentations (PPTX, ODP) use the same page
engine from 0.2.1; see [Spreadsheets](#spreadsheets-xlsx-and-ods) and
[Presentations](#presentations-pptx-and-odp) below.

| File | Role |
| --- | --- |
| `extension/src/attachments/pageLayout.js` | Shared page engine: pagination, page fields, rasterization, image and style-value checks. |
| `extension/src/attachments/odtLayout.js` | OpenDocument text to HTML pieces. |
| `extension/src/attachments/docxLayout.js` | Word document to HTML pieces, including OMML equations. |
| `extension/src/attachments/reader.js` | Text extraction, page text, fallback, and the reader result. |

The reader recognises an OpenDocument archive by its `content.xml` and its
`mimetype` entry. ODT covers `text`, `text-web` (LibreOffice Writer/Web),
`text-master` and `text-template`, and archives without a `mimetype` entry.
ODS and ODP also accept their `-template` variants.

Everything runs locally in the extension's offscreen document. Nothing is sent
anywhere until the page images and text join the normal evidence request.

## How a page is produced

1. The archive is read within the decompressed-size limit (48 MB).
   - **ODT:** `content.xml`, `styles.xml`, `Pictures/`, `ObjectReplacements/`
     and `Object N/content.xml`.
   - **DOCX:** the `word/` XML parts, their relationships, the theme and
     `word/media/`.
2. The text is extracted first, with the same rules and limits as before.
   - **ODT:** comments, tracked deletions and alt text are excluded; frames and
     notes are read once.
   - **DOCX:** deleted and moved-from text, field codes and `FILENAME` field
     results are excluded; text boxes are read once, without their VML fallback
     copy; invalid symbol codes are dropped.
   - **Both:** hidden text (Word `w:vanish`, ODT `text:display="none"`) is
     excluded. It is not drawn on the page either, so a student cannot hide
     instructions for the model that the teacher does not see. The receipt
     counts it as `hidden-text-excluded`.
   - **Both:** text that is drawn but cannot be seen is excluded after the
     pages are laid out (step 5).
3. The document is converted to HTML from its own styles:
   - **Text formatting:** fonts (including Word theme fonts), sizes, bold,
     italic, underline, strike-through, colours, highlighting, superscript and
     subscript.
   - **Paragraph formatting:** alignment, spacing, indents, line spacing,
     borders and shading.
   - **Tables:** column widths, merged cells (horizontal and vertical), cell
     borders and shading, and repeated header rows. Word table styles with
     first-row, last-row, first-column and banded-row formatting are included.
   - **Lists:** numbered and bulleted, with their format (`1.`, `1.1.`, `a)`,
     `i.`, bullets, including Symbol-font bullets) and indentation. ODT heading
     numbers come from the outline style. DOCX lists whose `w:num` has no
     override share the counters of their `w:abstractNum`, so a second list of
     the same definition continues the numbering; a `w:num` with a level
     override counts on its own. This matches how LibreOffice shows such
     documents.
   - **Page colour:** a Word page colour (`w:background`) and an ODT page
     background colour.
   - **Images:** PNG, JPEG, WebP, GIF, BMP and SVG, at their size in the
     document. Text boxes and shapes that contain text are drawn with their
     text, and text boxes with their fill and outline colours (ODT
     `draw:fill-color` and `svg:stroke-color`, DOCX `a:solidFill` and `a:ln`,
     VML `fillcolor` and `strokecolor`).
   - **Text wrapping:** anchored pictures and text boxes with square, tight or
     through wrapping (DOCX) or parallel, left or right wrapping (ODT) float on
     their side, with the text beside them; top-and-bottom and no wrapping keep
     them as a block between the lines; objects with no wrapping in DOCX, or
     run-through in ODT, are placed over (or behind) their paragraph.
   - **Columns:** sections with several columns (DOCX `w:cols`, ODT sections
     with `style:columns`) are drawn in balanced columns.
   - **Equations:** ODT formulas are MathML; Word equations (OMML) are converted
     to MathML.
   - **Footnotes:** at the bottom of the page that cites them, including notes
     cited in repeated table header rows. DOCX endnotes follow the body; ODT
     endnotes start on their own page, as Writer prints them.
   - **Headers and footers:** page number and page count fields included. For
     DOCX this covers the first-page header and footer, inheritance between
     sections. Centre, right and decimal tab stops (DOCX `w:tabs`, ODT
     `style:tab-stops`) place the text after each tab, in headers, footers and
     body lines.
4. The HTML is split into pages with the page size and margins (A4 portrait by
   default). A new page style (ODT) or section (DOCX) can change the page size,
   for example to landscape.
   - **Saved page breaks:** when the editor saved them, pages break exactly
     there, so page numbers match what the student saw. Writer saves
     `text:soft-page-break`; Word saves `w:lastRenderedPageBreak`. A paragraph
     the editor split across two pages is kept whole on the first page, which
     then grows slightly.
   - **No saved breaks:** for files from LibreOffice's DOCX export, generators
     or other editors, the layout is measured in the offscreen document. A
     paragraph that does not fit is split at the last line that does, keeping
     at least two lines on each page (widow and orphan control), and a
     paragraph longer than a page continues over several pages; its text is
     listed on the page where it starts. Other blocks move to the next page
     when they no longer fit. Tables break between rows and ODT lists between
     items.
   - **Explicit breaks:** page breaks and page-break-before settings are
     honoured in both modes. A Word page break in the middle of a paragraph
     splits it, so the text after the break starts the next page. Continuous
     DOCX section breaks change the page style from the next page.
   - **Stale saved breaks:** when a saved page holds half a page more than
     fits (the document was edited elsewhere after the editor last saved its
     breaks), the whole document is measured instead.
   - **Oversized content:** content taller than a page extends that page
     instead of being cut. A page more than about 1.25 times its size is drawn
     as up to four images, top to bottom, each legible at page resolution.
5. Each laid-out page is checked for text a reader could not see. Text is
   excluded from the extracted text, and counted as `invisible-text-excluded`,
   when its colour is too close to its background (contrast ratio below 1.25,
   for example white on white or `#F4F4F4` on white), its size is under 3.5
   CSS pixels (about 2.6 pt), its glyphs are squeezed to under one pixel each,
   or it lies outside the page or a clipping box. The background is the nearest
   shading, highlight, cell or page colour behind the text. Header and footer
   text is taken as drawn, without such text. A student could otherwise hide
   instructions for the model in white or tiny text. Text under a picture drawn
   after it (60% of each line covered by one picture, as on slides) is also
   excluded; text drawn over a picture stays.
   When the student's name is to be hidden, matching text is covered with a
   black bar on the page image (the extracted text is replaced later by the
   service worker).
6. With the default page-image setting, only pages that show more than text
   are drawn as images: images, formulas, tables, drawings and placeholders,
   borders, shading or highlighting, or struck-through text in the body or
   footnotes. Headers and footers do not count, so a logo there does not mark
   every page. Pages with only text, including bold, italic, underlined or
   coloured text, are sent as text. Options → "DOCX and ODT page images" →
   "Every page" draws all pages.
7. Each page to send is drawn into a canvas through an SVG `foreignObject` and encoded
   like a PDF page. It uses the same resolution (1191 × 1685 pixels for A4).
   It is PNG; when the PNG exceeds 400,000 characters of base64 and a JPEG at
   quality 0.9 is under half that size (photos, scans), the JPEG is used; above
   1.2 MB of base64 it is JPEG at quality 0.9, 0.85 or 0.7. PDF pages follow
   the same encoding.

Images are waited for with their `load` event, not `HTMLImageElement.decode()`.
`decode()` waits for animation frames, which never run in an offscreen
document. The wait is also capped at 2 seconds per image.

## What the reader returns

The result has the same shape as a PDF:

- `pageCount`, `images` (with `pageNumber`, and `part`/`parts` for a page drawn
  in parts) and `textPages` (text offsets per page), so evidence blocks keep
  each page's text beside its images;
- `textContent` with `Page N` sections and one line per page:
  `Page N: visual content attached as an image.`,
  `Page N: visual content attached as 3 images, top to bottom.`, or
  `Page N: text only (no images, formulas, tables or drawings); no page image
  attached.`;
- list, heading and bullet labels at the start of their paragraphs, as drawn
  (`1. Answer`, `1.1. Detail`, `• Point`);
- `extractedTextCharacters`, counting only the document's own text.

Header and footer text is listed as `[Header]` and `[Footer]` on the first
page that shows each one (for example page 2 after a different first page),
with that page's number and the page count. DOCX footnotes are listed on the
page that cites them as `[Footnotes]`, and endnotes on the last page as
`[Endnotes]`. Equations add a linear form to the text:
- ODT uses the formula's StarMath source, for example `[Formula: E = m c^2]`.
- DOCX uses the converted equation, for example `[Formula: x=(-b±sqrt(b^2-4ac))/(2a)]`.

The evidence receipt reports `pageCount` and `imagePages` for DOCX and ODT
files. `omittedImages` counts only objects that are actually used in the
document:

| Reason | Meaning |
| --- | --- |
| `unsupported-embedded-image-format` | An EMF, WMF, SVM, TIFF or unrecognised image. A dashed box marks its place on the page. |
| `embedded-image-size-limit` | A GIF, BMP or PNG whose header claims more than 16 megapixels or more than 16,384 pixels on one side. |
| `external-linked-image` | An image linked outside the file. It is never fetched. |
| `unsupported-embedded-object` | A chart, a SmartArt diagram, an embedded OLE object or a drawing shape without text. |
| `hidden-text-excluded` | Hidden text runs left out of the page and the text; for spreadsheets, cells with content in hidden sheets, rows and columns or hidden by their number format; for presentations, text on hidden slides and in hidden shapes. |
| `invisible-text-excluded` | Text runs drawn so that a reader could not see them, left out of the text. |
| `page-images-not-sent` | The Ollama model reports no image input: the page images were left out and the text was sent alone. |
| `page-rendering-failed` | Page rendering failed; see below. |

## Limits and failures

- A document above 60 pages stops correction, like a PDF.
- Tables are limited to 200,000 drawn elements per document. ODT repeated cells
  and rows multiply through nested tables: a file under 1 KB could otherwise
  build millions of elements before pagination could stop it.
- Page images above 48 MB per document stop correction with "DOCX/ODT page
  images exceed the safe transfer size".
- If rendering fails for any other reason, the file falls back to the previous
  behaviour: text plus embedded images, with `page-rendering-failed` in the
  receipt. The correction continues.
- Cancelling stops between pages and releases the canvas and the layout.
- Reading a file has a three-minute deadline in the service worker.
- The offscreen reader keeps up to eight drawn documents (at most 120 MB of
  text and images) in its memory for 30 minutes, keyed by the SHA-256 of the
  file, whether it is declared text, and the page-image setting. Correcting the
  same file again reuses its pages. Nothing is written to disk. Expired entries
  are dropped on a timer; once nothing is cached or being read for two minutes,
  the service worker closes the offscreen document, which releases PDF.js, its
  WebAssembly decoders and every drawn page.
- With an Ollama model that reports no image input, DOCX and ODT files are sent
  as text only, without their `Page N: visual content` lines, and the receipt
  reports `page-images-not-sent`. PDF pages and image files still need a
  vision model.

## Security

The document is student-supplied:

- Elements are created with DOM methods, never from markup strings.
- Every style value is checked before it becomes CSS: lengths, percentages and
  hex colours only, with a restricted font-name character set. Values such as
  `url(...)` are ignored.
- Images are loaded only as `data:` URLs built from the archive's own bytes.
  Linked images are never fetched.
- ODT MathML is copied element by element with a fixed attribute allowlist.
  Word equations are built from scratch.
- The SVG used for drawing runs as an image, so it cannot run scripts or load
  anything.

## Fidelity

The layout is a browser approximation, not Word or LibreOffice. In the
comparisons below the page count matched; the known differences are:

- Fonts that are not installed on the computer are replaced by similar fonts.
- Word's single line spacing is approximated as 1.15 times the font size (the
  line height of Liberation Serif and Times New Roman).
- Text wraps around anchored pictures and text boxes with CSS floats: on one
  side only (an object centred with text on both sides becomes a block), and
  from the paragraph it is anchored to (Writer can also wrap the paragraph
  above). Contour wrapping follows the object's box.
- Multi-column sections are balanced on each page; a paragraph that does not
  fit moves whole to the next page with a new column box instead of being
  split between columns. Lists and tables inside such a section stay full
  width.
- Without saved page breaks, line positions come from the browser's fonts, so
  page boundaries can differ by a few lines. `npm run test:fidelity` measures
  this against LibreOffice ([`rendering-fidelity.md`](rendering-fidelity.md)):
  19 of its 26 renderings match within the default thresholds and every page
  count matches; the remaining differences are listed there.
- ODT proportional line spacing is applied to the font's line height (1.15 em),
  as Writer does.
- List counters were checked against LibreOffice, not Word (Word is not
  available here): two `w:num` sharing a definition continue, a level
  override restarts, separate definitions count separately.
- A page with thousands of footnotes is drawn as one tall page, sent as up to
  four images; laying it out takes tens of seconds.
- The visibility check uses the drawn colours and positions: text the same
  colour as a picture behind it is not detected.
- Left tab stops (in a line with only left stops), leader characters, tabs
  inside a formatted span (ODT), decimal alignment on the separator (decimal
  stops right-align the text), column breaks, page borders and backgrounds,
  even/odd headers, drop caps and text direction are not reproduced.
- Charts, SmartArt and OLE objects appear as a dashed placeholder.
- Word table styles: only whole-table, first/last row and column, and
  horizontal banding are applied.

The prompt tells the model that DOCX and ODT page images are rendered locally
and may differ slightly from the original word processor.

## Validation (28 October 2026)

Fictional documents were created as flat ODT files, saved by LibreOffice
(`soffice --convert-to odt` and `--convert-to docx`) and exported by
LibreOffice to PDF for comparison. A Word-style DOCX was also written by hand
with Word's own structures: theme fonts, a table style with first-row and
banded shading, multilevel numbering, an equation, a footnote, a header with
centre and right tab stops, complex `PAGE` and `NUMPAGES` fields, a first-page
header, `w:lastRenderedPageBreak` and a landscape section. All were read by the
extension in Chromium.

| Document | Pages (extension / LibreOffice PDF) | Notes |
| --- | --- | --- |
| ODT, 4 pages: styles, lists, table, image, formula, footnote, header and footer | 4 / 4 | Same page boundaries; measured pagination without soft breaks also gave 4. 0.6 s. |
| ODT, 7 pages: 70-row table, WMF image, teacher comment, landscape page | 7 / 7 | Table header repeated; WMF reported and drawn as a placeholder; comment excluded. |
| ODT, 48 pages | 48 | 3.5 s. |
| DOCX exported by LibreOffice from the two ODT files above | 4 / 4 and 7 / 7 | Measured pagination; equation converted from OMML; WMF reported. |
| DOCX exported by LibreOffice from the 48-page ODT | 52 | 3.0 s. |
| Hand-written Word-style DOCX | 3 / 3 | Header tab stops, fields ("Page 2 of 3"), first-page header and landscape section rendered. |

Local `gemma4:e4b` answered questions that only the page images show:
- **ODT page 1:** the colour of a rectangle in the image, the heading number
  and the footer "Page 1 of 4". All three were correct.
- **Word-style DOCX:** the header row colour, the "1.1." list number, the
  equation's denominator, the first-page header, the left, centre and right
  header texts, and "Page 2 of 3". All eight were correct.

After the 0.2.1 review (see [`review-2026-10-28-0.2.1.md`](review-2026-10-28-0.2.1.md)),
`npm run check` passed 92 tests and `npm run test:browser` passed 98 checks.
New checks cover, for each format:
- saved page breaks;
- header page fields;
- repeated table headers and table-style shading;
- numbering, equations and footnotes;
- remote image links producing no network request (ODT and DOCX), and
  `url(...)` style values being ignored;
- hidden text, header-only tables, header-row footnotes, `FILENAME` fields,
  invalid symbols, mid-paragraph page breaks, moved text, stale saved breaks,
  nested repeated ODT tables, and the 48 MB and 20 MB reader limits;
- the 60-page limit;
- the fallback when rendering fails;
- cancellation;
- the page count in the receipt;
- an embedded image drawn by the real offscreen reader without delay.

These checks use fictional documents. They do not establish layout accuracy for
every document, editor or font, or grading accuracy.

## Spreadsheets (XLSX and ODS)

From 0.2.1, XLSX and ODS files are read the same way, printed the way a
spreadsheet application prints a sheet with gridlines and headings.

| File | Role |
| --- | --- |
| `extension/src/attachments/sheetLayout.js` | Workbook model (cells, styles, number formats, merges, comments, drawings), sheet pages and their text. |
| `extension/src/attachments/drawingml.js` | Shared Office Open XML helpers: parts and relationships, theme colours and fonts, DrawingML colours. |

The archive is read within the same 48 MB limit:
- **XLSX:** the `xl/` XML parts (workbook, shared strings, styles, theme,
  worksheets, comments, drawings), their relationships and `xl/media/`.
- **ODS:** `content.xml`, `styles.xml`, `Pictures/` and
  `Object N/content.xml`.

### Pages

- Each visible sheet starts a new page: landscape A4 with 1 cm margins, the
  sheet name at the top, gridlines, column letters repeated at the top of every
  page and row numbers on the left.
- The printed range runs from A1 to the last cell with a value, a formula or a
  comment, the end of a merged cell, or the end of an anchored picture or
  chart. Empty cells inside it are drawn; styled empty cells keep their fill
  and borders.
- Runs of more than 10 empty rows become one row reading "Rows 12–4999 are
  empty", and runs of more than 4 empty columns become one narrow column headed
  with their range (for example `F–Z`). A stray cell far from the data
  therefore adds one line, not hundreds of pages.
- Columns that do not fit the page width continue on the following pages,
  "down, then over": all rows of columns A–P, then all rows of Q–AD. Text keeps
  its size; nothing is scaled down. The page heading and the extracted text say
  which columns a page shows. A single column wider than the page is narrowed
  to the page width.
- Rows break between pages. Rows joined by a vertical merge stay on one page
  (up to 60 rows; a taller merge is drawn row by row).

### Cells

- Values are the ones the file saved, drawn as the cell shows them. Formulas
  are not recalculated.
  - **XLSX:** the cached value is formatted with the cell's number format:
    General, fixed decimals, thousands separators, percentages, scientific
    notation, literal text, negative and zero sections, dates and times
    (`yyyy`, `mmm`, `d`, `h:mm AM/PM`, elapsed `[h]:mm`...). The built-in short
    date formats (IDs 14 and 22) use ISO order (`2026-10-28`) instead of the
    computer's regional setting. Fractions use General. A format that shows
    nothing (`;;;`) hides the value: it is left out of the page and the text,
    and counted as `hidden-text-excluded`.
  - **ODS:** LibreOffice stores the displayed text of every cell, so the page
    shows it as saved (for example `12,5%` or `28/10/2026`).
- Shared strings, inline strings and rich text runs keep their own font.
  XLSX shared formulas are moved to each cell (`=B2*2` becomes `=B3*2`).
- Fonts (name, size, bold, italic, underline, strike-through, colour, theme
  colours with tints, indexed colours), solid fills, borders, horizontal and
  vertical alignment, wrapping, indents, column widths, row heights and merged
  cells are drawn. Numbers align right and text left unless the cell says
  otherwise.
- Text longer than its column runs over the empty cells to its right, as in
  the application. When the next cell is not empty, the text wraps and the row
  grows, instead of being cut off as a spreadsheet application would cut it.

### Comments, pictures and charts

- Cell comments (XLSX notes, ODS annotations) are printed below the rows of the
  page that shows their cell, like the "at end of sheet" print option, and the
  cell has a red corner marker. They are listed in the text as
  `[Comment B2: ...]`. Unlike word-processor comments (excluded from DOCX and
  ODT), a spreadsheet comment is usually the author's own explanation of a
  value. Author names are left out: the XLSX comment's leading bold
  "Author:" run is removed and ODS `dc:creator` is not read.
- Pictures anchored to cells are drawn over the cells at their anchor and
  size. Text boxes are drawn with their text and listed as
  `[Text box at D5]`.
- Charts, SmartArt, other drawing shapes and embedded objects are drawn as a
  dashed placeholder at their anchor and counted as
  `unsupported-embedded-object`.

### Hidden content

Hidden sheets (XLSX `hidden` and `veryHidden`, ODS `table:display="false"`),
hidden rows and columns (XLSX `hidden` or zero size, ODS
`table:visibility="collapse"` or `"filter"`) are not drawn and not sent as
text. Their cells with content are counted as `hidden-text-excluded`. Text
drawn invisibly in a visible cell (white on white, under about 2.6 pt) is left
out of the text and counted as `invisible-text-excluded`, as for DOCX and ODT.

### Text

Each page's text names the sheet, then lists every non-empty cell on that page
row by row, tab-separated, with its reference. A formula follows its saved
result in parentheses. Line breaks inside a cell become ` / `.

```text
[Sheet: Grades]
A1: Name	B1: Score
A2: Ana García	B2: 7.50	C2: 15 (=B2*2)
[Comment B2: Check the rounding]
A6 (merged A6:C6): MERGED TITLE
```

When a sheet is split into column bands, the heading names the columns:
`[Sheet: Grades, columns Q–AD]`. An empty visible sheet gives a page with
`(empty sheet)`.

### Limits

- 10,000 non-empty cells per file. Above it the correction stops with
  "XLSX exceeds the 10,000 non-empty cell limit" (code `PAGE_LIMIT`), like the
  60-page limit.
- 200,000 drawn table elements per file, checked before the rows are built.
- ODS repeated rows and cells (`number-rows-repeated`,
  `number-columns-repeated`) only move the position on when they are empty, so
  the million empty rows LibreOffice writes after the data cost nothing. A
  repeated row or cell with content counts every copy against the cell limit
  before any copy is made: a 1 KB file declaring 1,048,576 repeated rows of
  16,384 filled cells stops in milliseconds.
- Styled empty cells are kept up to 100,000 per sheet and only in blocks of up
  to 100 repeats; merged ranges above 10,000 cells are drawn as a single cell;
  500 drawings per sheet.
- Not reproduced: conditional formatting, data bars and sparklines, Excel
  table (ListObject) styles, pivot table formatting, rotated or vertical text,
  print areas, print titles, page setup (orientation, scaling, margins), freeze
  panes, gradient fills (first colour), pattern fills (foreground colour) and
  grouped drawings (drawn as a placeholder).

## Presentations (PPTX and ODP)

From 0.2.1, PPTX and ODP files become one page per visible slide, at the
presentation's slide size (PPTX `p:sldSz`, ODP the master page's page layout).
A 16:9 slide is drawn at 1920 × 1080 pixels.

| File | Role |
| --- | --- |
| `extension/src/attachments/slideLayout.js` | Slide model for both formats, the slide renderer and the slide text. |

The archive is read within the same 48 MB limit:
- **PPTX:** `ppt/presentation.xml`, the slides, slide layouts, slide masters,
  notes slides, theme, table styles, their relationships and `ppt/media/`.
- **ODP:** `content.xml`, `styles.xml`, `Pictures/` and `Object N/content.xml`.

### What is drawn

- **Placeholders:** a PPTX slide placeholder without its own position takes it
  from the matching layout placeholder (by index, then type), then from the
  master. Text styles follow PowerPoint's order: master title, body or other
  text style (and the presentation's default text style for text boxes),
  master and layout placeholder list styles, the shape's own list style, then
  paragraph and run properties. Empty placeholders are not drawn.
- **Master and layout decorations:** shapes and pictures on the master and
  layout that are not placeholders are drawn behind the slide, unless the slide
  or layout turns them off (`showMasterSp="0"`). Their text is not extracted.
- **Backgrounds:** solid, gradient and picture backgrounds, from the slide,
  then the layout, then the master (PPTX, including theme background styles);
  ODP page and master page fills.
- **Text:** fonts (including theme fonts), sizes, bold, italic, underline,
  strike-through, capitals, colours (theme colours with their luminance, tint,
  shade and transparency modifiers), highlighting, superscript and subscript,
  alignment, indents, line and paragraph spacing, vertical anchoring, insets,
  no-wrap, and the font scale PowerPoint saves for text that shrinks to fit.
- **Bullets and numbering:** bullet characters (Wingdings and Symbol bullets
  mapped to their usual shapes) and automatic numbering (`1.`, `a)`, `(i)`,
  ...); ODP list styles.
- **Pictures**, with cropping and flips; picture fills of shapes.
- **Shapes:** solid and gradient fills, fills and outlines from the shape style
  (`p:style`), outlines with their width, dashed outlines; rectangles, rounded
  rectangles and ellipses, and as polygons triangles, right triangles,
  diamonds, parallelograms, trapezoids, pentagons, hexagons, chevrons, arrows
  and five-pointed stars. Other preset shapes are drawn as rectangles; a
  freeform shape without text is not drawn and is counted as
  `unsupported-embedded-object`.
- **Lines and connectors**, rotation, flips and **groups** (children placed
  through the group's coordinate transform).
- **Tables:** column widths, row heights, merged cells, cell fills, borders,
  margins and anchoring, and the table style parts the file contains (whole
  table, banded rows, first and last row and column). PowerPoint's default
  style "Medium Style 2 – Accent 1", which PowerPoint does not write into the
  file, is reproduced from the theme's accent colour.
- **Not drawn:** charts, SmartArt, embedded objects and media (their poster
  picture is drawn) appear as a dashed placeholder and are counted as
  `unsupported-embedded-object`; ink is counted as a drawing. Shadows, glow,
  reflections, 3-D, WordArt transforms, vertical text, animations and
  transitions are not reproduced, and group rotation is ignored.

A slide's content is clipped to the slide: text or shapes outside it are not
drawn, cannot extend the page, and their text counts as invisible.

### Hidden and invisible content

- Hidden slides (PPTX `show="0"`, ODP `presentation:visibility="hidden"`) and
  hidden PPTX shapes are not drawn and not sent as text. Their text runs (ODP: their
  paragraphs) are counted as `hidden-text-excluded`.
- Text drawn invisibly is left out of the text and counted as
  `invisible-text-excluded`, as for DOCX and ODT: white text on a white slide,
  text under about 2.6 pt, text off the slide. Text over a picture is checked
  against the picture's mean colour (so white text on a dark photo stays), and
  text in a triangle, arrow or other polygon against the shape's fill.

### Text

Each page's text starts with `[Slide N]`, the slide's number in the file
(hidden slides keep their numbers, so page 2 can be `[Slide 3]`). The title
comes first, then the other text top to bottom and left to right (shapes whose
top edges are within 8 px count as the same line), with bullets and numbers as
drawn. Tables are listed as tab-separated rows. Speaker notes follow as
`[Speaker notes]`: they are not drawn on the slide, but they are the student's
own notes for the presentation. Comments and picture descriptions (alt text)
are not read.

```text
[Slide 1]
Photosynthesis
• Light reactions
• Calvin cycle
[Speaker notes]
Mention chlorophyll
```

With page images limited to visual pages (the default), a slide with only text
on a white background is sent as text; slides with pictures, tables, shapes,
fills or a coloured background are sent as images.

### Limits

- 60 visible slides, checked before any slide is drawn.
- 5,000 shapes and 20,000 table cells per file, and groups nested at most 20
  deep (`PAGE_LIMIT`).
- The same 48 MB page-image limit, fallback and cancellation as DOCX and ODT.

## Validation of spreadsheets and presentations (28 October 2026)

Fictional XLSX and PPTX files written by hand with Excel and PowerPoint
structures were converted by LibreOffice (`soffice --convert-to ods`,
`--convert-to odp` and `--convert-to pdf`) and all four were read by the
extension in Chromium:
- The LibreOffice ODS gave the same cells, formulas, merged cell, comment,
  picture, hidden-content count (3) and invisible-text count (1) as the XLSX,
  with LibreOffice's own displayed values (`7,50`, `28/10/2026`, `VERDADERO`).
- The LibreOffice ODP gave the same slide text, reading order, speaker notes,
  hidden slide and invisible-text count as the PPTX. Slide images matched
  LibreOffice's PDF in title and bullet position, fills and table layout; we
  additionally draw PowerPoint's default table style, which LibreOffice
  ignores.
- A 30-column, 290-row XLSX became 20 landscape pages (two column bands) in
  4.4 s.

`npm run test:browser` checks, with fictional files built in memory
(`tests/fixtures/office-models.mjs`): XLSX values, number formats, shared
strings, rich text, shared formulas, merged cells, comments, an anchored
picture, a chart placeholder, hidden sheet, row and column, white text and the
rendering-failure fallback; ODS repeated rows and columns, trailing empty
repeats, the repeated-content bomb, formulas, comments, merged cells and
hidden rows and sheets; PPTX placeholders inherited from the layout and master,
a picture, white text on the slide and over a dark picture, a filled shape,
a table with the default table style, a chart placeholder, a hidden slide,
speaker notes and text-only slides; an ODP slide with frames, a list, a filled
ellipse, notes and a hidden slide. `npm run check` covers the number formats,
formula moving and OpenFormula references, and the receipt and text-only model
handling of the new formats.
