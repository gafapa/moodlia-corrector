# DOCX and ODT rendering fidelity check

`npm run test:fidelity` compares the extension's own DOCX and ODT page images
(see [office-page-rendering.md](office-page-rendering.md)) with LibreOffice's
rendering of the same files, page by page, over a corpus of fictional
documents. It catches layout regressions (lost content, wrong page breaks,
lost images, tables or columns) without manual review.

The reference is **LibreOffice**, not Microsoft Word. A file that matches here
renders like LibreOffice renders it; nothing in this check measures Word
fidelity.

## Running it

```bash
npm run build            # the check loads the built extension
npm run test:fidelity    # about 35 s for the 26 renderings
```

Options (pass after `--`, for example `npm run test:fidelity -- --only notes`):

| Option | Effect |
| --- | --- |
| `--only name,name` | Check only these corpus documents (names without extension). |
| `--format odt` or `--format docx` | Check one format only. |
| `--all-diffs` | Write a comparison image for every page, not only failing ones. |
| `--out <dir>` | Output directory (default `tests/fidelity/output/`, ignored by Git). |

The check prints one line per file and a summary table, writes
`report.json` (per-page metrics, render times, receipt limitations) to the
output directory and, for every failing page, a PNG with three panels:
LibreOffice | extension | overlay (reference ink red, extension ink blue,
shared ink black). It exits with code 1 when any file breaks its manifest
expectations.

Status per file:

- **PASS**: page count equal and every page above the default thresholds.
- **KNOWN**: a documented difference (see below); the file has its own
  minimums, set just under its current scores, so it still fails if it gets
  worse. When a known file reaches the defaults, the check says so and the
  entry should be removed from the manifest.
- **FAIL**: below its thresholds, page count outside its tolerance, a page not
  rasterized, or a reading error.

## How it works

`tests/fidelity-check.mjs` loads `extension/` in Playwright Chromium (as
`tests/browser-check.mjs` does) and calls `readAttachment()` from
`src/attachments/reader.js` in the extension page, with the default options,
so every page is rasterized:

1. Each corpus DOCX/ODT goes through the extension's DOCX/ODT page renderer.
2. The LibreOffice PDF of that same file goes through the extension's PDF path
   (pdf.js), so both sides are rasterized at the same resolution
   (about 1191 x 1684 px for A4) by the code that serves real submissions.
3. Pages are compared in order. The page count must match exactly unless the
   manifest gives a tolerance.

### Metrics

Each page image is reduced to a grid of about 1.2 mm cells (170 cells across a
portrait page) holding the mean ink (darkness) of the cell, computed from the
full-resolution pixels. A cell is "ink" above a mean darkness of 0.08.

| Metric | What it measures | Tolerates | Catches |
| --- | --- | --- | --- |
| `match` | F1 of the two ink masks, where a cell matches if the other side has ink within 3 cells (~3.7 mm). | Font substitution, line breaks at slightly different words, shifts of a few mm. | Missing, extra or moved content (lost images or tables, text on the wrong page). |
| `rows` | Correlation of the smoothed row ink profiles. | Horizontal differences. | Drift in vertical rhythm: line spacing, paragraph spacing, page breaks in different places. |
| `columns` | Correlation of the smoothed column ink profiles. | Vertical drift. | Wrong widths (tables, images), wrong horizontal placement or indentation. |
| `coverage` | Smaller / larger total ink. | Placement. | Lost or added content, shading and pictures. |
| `gutters` | Agreement of wide vertical gaps found in sliding windows of 24 rows (~3 cm): columns, text beside a picture, table cells, tab stops. | Word spacing, short last lines. | Lost columns or text wrapping, tab stops ignored; these keep the amount of ink but change the structure. |
| `aspect` | Ratio of the two page shapes. | | Wrong page size or orientation, or a page extended by overflowing content. |

A file's score for each metric is its worst page.

### Thresholds

Stored in `tests/fixtures/fidelity/manifest.json` with a rationale. The
defaults were calibrated on the pages that render like LibreOffice
(`tables-styled.docx`, `table-long.docx`, `landscape-sections.docx`,
`math-formula.docx` and the unaffected pages of the other files, which score
match >= 0.95, rows >= 0.85, columns >= 0.95, coverage >= 0.9,
gutters >= 0.85), with headroom for font substitution:

| match | rows | columns | coverage | gutters | aspect | page count |
| --- | --- | --- | --- | --- | --- | --- |
| 0.90 | 0.80 | 0.90 | 0.85 | 0.70 | 0.98 | exact |

Files below the defaults are listed in the manifest as `knownDifference` with
the reason, a page tolerance when their page count differs, and their own
minimums (the observed score minus 0.05). The observed scores are recorded
under `observed` in each entry. Thresholds were not lowered to hide defects:
every known difference below is a real difference from LibreOffice and is
reported as such.

The scores depend on the fonts installed. The corpus uses Liberation Serif,
Sans and Mono; where Chromium does not find them it falls back to the
metric-compatible Times New Roman, Arial and Courier New, which the
thresholds tolerate.

## The corpus

`tests/fixtures/fidelity/`, all fictional (invented places, people and
figures):

| Document | Covers |
| --- | --- |
| `prose-multipage` | Plain justified prose over three pages, 115% line spacing. |
| `headings-outline` | Headings 1 to 3 with outline numbering (1., 1.1, 1.1.1). |
| `lists-nested` | Nested numbered (1. / a) / i.) and bulleted lists, continuation after a paragraph, a restarted list, a list starting at 5. |
| `tables-styled` | Header row, shading, thick and thin borders, horizontal and vertical merged cells, a table with only bottom rules. |
| `table-long` | A 70-row table over three pages with a repeated header row and banded shading. |
| `images` | PNG inline in a sentence, PNG centred in its own paragraph, JPEG anchored to a paragraph with text wrapping, PNG anchored without wrapping. |
| `notes` | Footnotes over two pages and endnotes. |
| `header-footer` | Different first page header, header with centre and right tab stops, footer with "Page N of M" fields. |
| `landscape-sections` | Portrait, landscape and portrait pages with a wide table on the landscape page. |
| `math-formula` | Two formulas (quadratic formula, sum of squares). |
| `breaks` | Page break before a heading, a section with different margins, a two-column section. |
| `text-boxes` | A text box anchored to a paragraph with wrapping and fill, and a full-width text box without wrapping. |
| `mixed-fonts` | Sizes from 8 to 28 pt, serif, sans and monospace, bold, colour, underline, highlight, superscript, a shaded code block, right alignment. |

For each document there are:

- `source/<name>.fodt`: the Flat ODT source written by the generator;
- `<name>.odt` and `<name>.docx`: LibreOffice's conversions of that source
  (the ODT without its preview thumbnail, which takes no part in layout);
- `reference/<name>.odt.pdf` and `reference/<name>.docx.pdf`: LibreOffice's
  PDF of each of those two files.

The DOCX reference is LibreOffice's rendering of the DOCX file, so a DOCX and
its ODT twin can legitimately differ (for example, LibreOffice's DOCX export
merges the restarted list of `lists-nested` into one numbering sequence; both
LibreOffice and the extension then number it 6, 7, 8).

Coverage gaps: LibreOffice's headless conversion does not write
`text:soft-page-break` (ODT) or `w:lastRenderedPageBreak` (DOCX), so this
corpus exercises the measured pagination only, not the saved-page-break path.
No document comes from Microsoft Word.

### Regenerating

```bash
node tests/fidelity/generate-corpus.mjs [--only name,name] [--soffice <path>]
```

It writes the `.fodt` sources and, when LibreOffice is found (`--soffice`, the
`SOFFICE` variable, or the usual install paths), converts them to ODT and DOCX
and prints the reference PDFs, using a private LibreOffice profile so it runs
while LibreOffice is open. Without LibreOffice it only rewrites the sources and
keeps the stored files. The text is generated from a seeded word list, so the
content is reproducible; the binaries still change byte-wise on each run
because LibreOffice stores dates. The JPEG picture is encoded by Playwright's
Chromium. After regenerating, run the check and update `pages`, the
thresholds and `observed` in the manifest if the references changed. The
corpus was generated with LibreOffice 26.8.0.3.

The stored corpus is about 290 kB of DOCX/ODT, 1.7 MB of reference PDFs
(embedded font subsets) and 320 kB of sources.

## Current results

Measured on 2026-10-28 after the layout fixes listed below (first measurement
the same day: 4 of 26 met the defaults and 4 files had different page counts;
after the first round of fixes, 12 of 26). Pages are extension / LibreOffice;
scores are the worst page.

| File | Pages | match | rows | columns | coverage | gutters | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `prose-multipage.odt` | 3 / 3 | 1.00 | 0.97 | 1.00 | 0.99 | 0.63 | KNOWN |
| `prose-multipage.docx` | 3 / 3 | 1.00 | 0.98 | 1.00 | 0.99 | 0.83 | PASS |
| `headings-outline.odt` | 3 / 3 | 1.00 | 0.97 | 1.00 | 1.00 | 1.00 | PASS |
| `headings-outline.docx` | 3 / 3 | 1.00 | 0.93 | 1.00 | 1.00 | 1.00 | PASS |
| `lists-nested.odt` | 2 / 2 | 1.00 | 0.96 | 1.00 | 1.00 | 0.87 | PASS |
| `lists-nested.docx` | 2 / 2 | 1.00 | 0.97 | 1.00 | 1.00 | 0.87 | PASS |
| `tables-styled.odt` | 1 / 1 | 0.99 | 1.00 | 1.00 | 0.99 | 1.00 | PASS |
| `tables-styled.docx` | 1 / 1 | 1.00 | 1.00 | 1.00 | 0.98 | 1.00 | PASS |
| `table-long.odt` | 3 / 3 | 0.95 | 0.96 | 1.00 | 0.85 | 1.00 | KNOWN |
| `table-long.docx` | 3 / 3 | 0.97 | 0.98 | 1.00 | 0.91 | 1.00 | PASS |
| `images.odt` | 2 / 2 | 0.61 | 0.57 | 0.98 | 0.96 | 0.88 | KNOWN |
| `images.docx` | 2 / 2 | 1.00 | 0.99 | 1.00 | 0.98 | 0.78 | PASS |
| `notes.odt` | 3 / 3 | 1.00 | 0.97 | 0.98 | 0.98 | 1.00 | PASS |
| `notes.docx` | 2 / 2 | 1.00 | 0.97 | 1.00 | 0.99 | 0.87 | PASS |
| `header-footer.odt` | 3 / 3 | 1.00 | 0.97 | 1.00 | 1.00 | 0.60 | KNOWN |
| `header-footer.docx` | 3 / 3 | 1.00 | 0.98 | 1.00 | 1.00 | 1.00 | PASS |
| `landscape-sections.odt` | 3 / 3 | 1.00 | 1.00 | 1.00 | 0.95 | 1.00 | PASS |
| `landscape-sections.docx` | 3 / 3 | 1.00 | 1.00 | 1.00 | 0.94 | 1.00 | PASS |
| `math-formula.odt` | 1 / 1 | 0.89 | 0.85 | 1.00 | 0.97 | 0.00 | KNOWN |
| `math-formula.docx` | 1 / 1 | 1.00 | 0.99 | 1.00 | 0.98 | 0.00 | KNOWN |
| `breaks.odt` | 4 / 4 | 1.00 | 1.00 | 1.00 | 0.99 | 1.00 | PASS |
| `breaks.docx` | 4 / 4 | 0.97 | 0.92 | 1.00 | 0.99 | 1.00 | PASS |
| `text-boxes.odt` | 1 / 1 | 0.90 | 0.69 | 0.97 | 0.99 | 0.83 | KNOWN |
| `text-boxes.docx` | 1 / 1 | 1.00 | 0.96 | 1.00 | 0.99 | 1.00 | PASS |
| `mixed-fonts.odt` | 1 / 1 | 0.99 | 0.91 | 1.00 | 0.99 | 1.00 | PASS |
| `mixed-fonts.docx` | 1 / 1 | 1.00 | 0.95 | 1.00 | 0.99 | 1.00 | PASS |

19 of 26 renderings meet the defaults; 7 are known differences; none fail.
Every page count matches. Three of the known differences
(`prose-multipage.odt`, `header-footer.odt`, `math-formula.docx`) are
gutter-metric artifacts on pages that otherwise match line for line (see
below).

Rendering time: the check prints each file's render time. The 26 renderings
took 4.3 s in total before the second round of fixes and 4.5 to 5.0 s after
it on the same computer (runs vary by about 10% with machine load).

## Known differences

Found by reading the comparison images (left LibreOffice, middle extension)
and the layout code.

### Writer moves a line out of the way of a hanging frame

`images.odt`, page 2.

The 12 x 8 cm chart (wrap none, `style:flow-with-text="false"`) does not fit
under the text of page 1. Writer keeps it on page 1, hanging into the bottom
margin; the extension does the same (pieces marked `overhang` in
`pageLayout.js`). Writer then also moves the last line of the paragraph above
("the persistent fog."), which the frame now covers, to page 2; the extension
keeps that line on page 1, so page 2 starts one line higher. Small bitmaps
scaled up are smoothed by Chromium, while pdf.js draws them with sharp pixels.

### Writer also wraps the paragraph above an anchored frame

`text-boxes.odt`.

Writer wraps the centred title, which comes before the frame's anchor
paragraph, around the paragraph-anchored "Tip" frame, so the title breaks onto
two lines and everything below moves down by one title line. The extension
floats the frame from its anchor paragraph, so only that paragraph and the
ones after it wrap. The frame's position, fill, outline and the full-width
notice match; the DOCX twin matches.

### Rows of a long ODT table are a fraction of a pixel taller

`table-long.odt`, page 3.

Each row is a fraction of a pixel taller than LibreOffice's (cell padding and
font rounding), which adds up over 70 rows: page 2 holds two rows fewer and
page 3 two more, so the last page's ink coverage differs. Header repetition,
widths and banding match.

### ODT formulas are typeset by Chromium

`math-formula.odt`.

The formula is complete, but Chromium's MathML is about 20% smaller and spaced
differently from LibreOffice Math, so the text after each formula sits higher.
The DOCX twin (OMML converted to MathML) matches in placement.

### Gutter-metric artifacts

`prose-multipage.odt` (page 1), `header-footer.odt` (page 2),
`math-formula.docx` and `math-formula.odt`.

The last measuring window of these pages (3 cm tall) holds a short or single
line plus only the descenders of the line above it, so the empty width beside
the short line, or the word gaps of a split justified line, count as gutters
on the extension's side only. A one-pixel difference in where that line falls
decides it. The text, line positions and page breaks match (match 0.99 or more
and rows 0.97 or more, except the formula page). The thresholds were not
lowered; these files keep their own minimums.

## Fixed differences

All on 28 October 2026. First round:

- **ODT proportional line spacing** (`fo:line-height="115%"`) is applied to
  the font's line height (1.15 em), not its size.
- **Paragraphs are split across pages** at the last line that fits.
- **ODT tables aligned to the margins** span the text width; columns with only
  relative widths share it.
- **Small-font DOCX paragraphs** take the size of their largest run.

Second round:

- **Text wrapping around anchored pictures and text boxes.** DOCX `wp:anchor`
  with `wrapSquare`, `wrapTight` or `wrapThrough` floats left or right
  (`positionH` alignment, or the side of the column its offset falls on), with
  `distL`, `distR`, `distT` and `distB` as margins; `wrapTopAndBottom` is a
  block aligned by `positionH`; `wrapNone` is placed over its paragraph
  (behind the text with `behindDoc`). VML text boxes with `position:absolute`
  and square wrapping float to their `mso-position-horizontal` side. ODT
  frames anchored to a paragraph or character with `style:wrap` parallel,
  dynamic, biggest, left or right float on their side with their
  `fo:margin-*`; wrap none is a block aligned by `style:horizontal-pos`;
  run-through is placed over its paragraph (behind the text with
  `style:run-through="background"`). A float that does not fit the rest of
  the page moves to the next page with its paragraph. A paragraph holding only
  a block picture or frame keeps its empty line under it, as Word and Writer
  show it.
- **Text box fill and outline.** ODT `draw:fill="solid"` with
  `draw:fill-color`, and `draw:stroke` with `svg:stroke-color` and
  `svg:stroke-width` (a text frame without `draw:stroke` or `fo:border` keeps
  the default style's outline, as Writer draws it); DOCX `a:solidFill` and
  `a:ln` in `wps:spPr` with the `wps:bodyPr` insets, and VML `fillcolor`,
  `strokecolor`, `filled` and `stroked`. Text boxes no longer inherit the
  justification, first-line indent or line spacing of the paragraph they are
  anchored in.
- **ODT tab stops.** `style:tab-stops` with centre, right or decimal stops
  place the text after each tab at its stop, in headers, footers and body
  lines, as the DOCX side does.
- **Multi-column sections.** DOCX `w:cols w:num` and ODT `text:section` with
  `style:columns fo:column-count` draw the section's paragraphs in balanced
  CSS columns; when they do not fit, the remaining paragraphs continue in a new
  column box on the next page, so no text is lost. Lists and tables inside stay
  full width.
- **Empty section and page-break paragraphs.** DOCX follows Word, where
  students write it: an empty paragraph that only closes a section keeps its
  line, and the empty rest of a paragraph after its page break takes a line at
  the top of the next page when the document is in compatibility mode 15
  (Word 2013 and later, `w:compatSetting`) and no line in older modes or
  without the setting. LibreOffice drops both lines, so `breaks.docx` (no
  compatibility setting, one section-closing paragraph) scores lower against
  its reference (match 0.93, rows 0.88) while staying within the defaults.
- **Line spacing and page ends.** DOCX automatic spacing uses 1.15 times the
  font size (it was 1.14). ODT paragraph spacing is added, not collapsed
  (Writer adds the space below one paragraph to the space above the next).
  Spacing above a paragraph or table moved to the top of a page by a natural
  break is dropped, and spacing below the last paragraph of a page no longer
  pushes it to the next page. Without `w:widowControl` (DOCX) or
  `fo:widows`/`fo:orphans` (ODT) a paragraph may leave a single line on either
  page; `w:keepLines` and `fo:keep-together` keep it whole. A justified
  paragraph split across pages stays justified up to the break. Inline DOCX
  pictures sit on the baseline; character-anchored ODT frames follow
  `style:vertical-pos`.
- **ODT endnotes** start on their own page, in the page style named by the
  endnote configuration, as Writer prints them.
