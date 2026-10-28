# Improvements after the 0.2.1 review

Date: 28 October 2026. These changes follow the
[0.2.1 review](review-2026-10-28-0.2.1.md) and ship in 0.2.1, which is not yet
published. They address the limits that review left open and add tests that
the review could not run.

## Security: text the teacher cannot see

The review left hidden text (`w:vanish`, `text:display="none"`) out of what is
sent. A student could still hide instructions for the model by drawing text
that nobody can read. Each DOCX and ODT page is now checked after layout, and
text is left out of the extracted text when:

- its colour is too close to the colour behind it (contrast ratio below 1.25:
  white on white, `#F4F4F4` on white). The background is the nearest shading,
  highlight, table cell or page colour;
- it is smaller than 3.5 CSS pixels (about 2.6 pt);
- its glyphs are squeezed to under one pixel each (negative letter spacing);
- it lies outside the page or outside a box that clips it.

Each drawn text node is mapped back to the XML text it came from, so only that
text is removed; the rest of the paragraph stays. Header and footer text is
taken as drawn, without such text. The receipt counts the runs as
`invisible-text-excluded`, and the prompt explains that reason. Word page
colours (`w:background`) and ODT page backgrounds are now drawn, so light text
on a dark page is kept.

Not detected: text hidden behind an image, or coloured like a picture behind
it.

## Text fidelity

- **List numbers in the text.** List, heading and bullet labels are added to
  the start of their paragraphs as drawn (`1. Answer`, `1.1. Detail`). A model
  reading the text, or a text-only model, can now tell which answer belongs to
  which question.
- **Word numbering across lists.** Word was not available to check how
  numbering continues across `w:num` entries. LibreOffice, which imports Word
  documents with Word's rules, was used instead on four built documents:

  | Case | LibreOffice | Before | Now |
  | --- | --- | --- | --- |
  | Two `w:num` sharing one `w:abstractNum`, no override | 1, 2, 3, 4 | 1, 2, 1, 2 | 1, 2, 3, 4 |
  | The same, interleaved | 1, 2, 3, 4 | 1, 1, 2, 2 | 1, 2, 3, 4 |
  | Second `w:num` with a `startOverride` | 1, 2, 1, 2 | 1, 2, 1, 2 | 1, 2, 1, 2 |
  | Separate `w:abstractNum` definitions | 1, 2, 1, 2 | 1, 2, 1, 2 | 1, 2, 1, 2 |

  Counters are now kept per `w:abstractNum` for a `w:num` without overrides,
  and per `w:num` when it has a level override.

## Cost and speed

- **Text-only pages are sent as text.** By default a DOCX or ODT page is drawn
  as an image only when its body or notes show images, formulas, tables,
  drawings or placeholders, borders, shading or highlighting, or
  struck-through text. Pages with only text, including bold, italic, underlined
  or coloured text, are sent as text with the line `Page N: text only (no
  images, formulas, tables or drawings); no page image attached.` The prompt
  tells the model that such a page's text is its complete evidence. Options →
  **DOCX and ODT page images** → **Every page** restores the previous
  behaviour, for assessments where layout or formatting counts. PDF pages are
  always images.
- **JPEG for photos.** A page whose PNG is over 400,000 characters of base64 is
  also encoded as JPEG at quality 0.9, which is used when it is under half the
  PNG. Typed pages stay PNG.
- **Very tall pages in parts.** A page more than about 1.25 times its size
  (thousands of footnotes, a very long table row) is drawn as up to four
  images, top to bottom, at page resolution, instead of one image shrunk to
  the 16-megapixel canvas limit. The parts travel in the same evidence block.
- **Reuse of drawn pages.** The offscreen reader keeps up to eight drawn
  documents (120 MB of text and images at most) in memory for 30 minutes,
  keyed by the file's SHA-256, whether it is declared text, and the page-image
  setting. Correcting the same submission again, for example with other
  instructions or another model, skips the layout. Nothing is written to disk.
  Direct calls to `readAttachment` (tests) bypass it.

## Panel

- **Progress.** The service worker sends progress over the long-request port:
  downloads, reading each file, the model check, each evidence block, writing
  the correction and repair. The panel shows the step with the elapsed
  seconds, for example `Leyendo archivos (2 de 3)... (14 s)`.
- **Correct when moving to the next student.** A new panel option. With it on,
  moving to another student starts that student's correction once their data
  is read. It never starts for a student already corrected on the page (saving
  reloads the same student) and nothing is saved: the teacher still reviews
  and saves each grade. The setting is stored locally.
- **Fixed: correction cut off at 30 minutes.** The panel's runtime client
  cancelled long requests after 30 minutes, although the service worker allows
  60. It now waits 61 minutes, so the service worker's own error arrives
  first.
- **Fixed: "applied" with a locked grade.** Found by the real-Moodle check
  below. When Moodle shows its static "grade locked" element (`gradedisabled`)
  instead of a grade input, the AI is not asked for a score, so the earlier fix
  (which looked at the proposed score) still reported "applied". The status now
  says the feedback was applied but not the grade.

## New tests

| Test | What it covers | Result |
| --- | --- | --- |
| `npm run check` | Unit tests, including progress messages, page parts and text-only labels in evidence blocks. | 96 passed |
| `npm run test:browser` | New Chromium checks: invisible text in DOCX and ODT (white, pale, tiny, squeezed, off the page) with contrasting text kept; a dark Word page colour; text-only pages without images and a table page with one; a tall page in four parts; the read cache; shared-definition numbering; progress text; automatic next-student correction without repeats; the locked-grade status for a correction without a score; both page-image settings end to end, and a paragraph continuing over several pages. | 105 passed |
| `npm run test:locales` | Eight languages, including the new strings. | 10 passed |
| `node tests/live-office-check.mjs` | Local `gemma4:e4b` with a fictional DOCX and ODT (see below). | Passed on the second of two runs |
| `npm run test:fidelity` | Our DOCX and ODT pages against LibreOffice PDFs over 13 fictional documents in both formats (see below). | 12 of 26 within the default thresholds, 14 known differences, none failing |
| `tests/moodle-lab-check.mjs` | The built extension against a real disposable Moodle site (see below). | Passed on Moodle 5.2.4 and 4.5.12 |

### Live check with DOCX and ODT

Each document has a text-only first page and a second page with a table and a
red square image, plus a white sentence telling the model to award zero. The
check asserts that the white sentence never reaches the model, the receipt
reports it, page 1 is sent as text with its list numbers, and only page 2 is
sent as an image.

- Run 1: DOCX 7/10. The request was correct (one page image, red square drawn,
  confirmed by saving the image), but the model judged the flag missing. The
  check stopped there.
- Run 2: DOCX 10/10 in 32 s, ODT 10/10 in 25 s, one request each, about 4,950
  prompt tokens.

A small local model can miss image evidence that was sent; the teacher's review
remains necessary.

### Real Moodle

`tests/moodle-lab-check.mjs` starts nothing itself: it drives Chromium with the
built extension against a running Moodle. `tests/moodle-lab/setup.php` creates
a course, a teacher, an assignment with file and online-text submissions, and
two students; the second student's grade is overridden and locked in the
gradebook. The check signs in as the teacher, opens the grader, corrects with a
fake AI server, verifies that the fake AI received the PDF's text downloaded
with the teacher's session, saves and reloads, and checks the locked-grade
status. The extension only runs on HTTPS grader pages, so the check serves the
HTTP lab container through its own TLS proxy.

The **Moodle lab** workflow (`.github/workflows/moodle-lab.yml`, manual or
weekly) runs it on Moodle 4.5, 5.0, 5.1, 5.2 and 5.3 with the public
`ghcr.io/gafapa/moodlia-lab:<branch>-core` images; it has not run on GitHub
yet.

On 28 October 2026 the check was run against real Moodle sites on the S1 lab
server (ARM64; the published lab images are amd64 only). One disposable
container at a time (`erseco/alpine-moodle`, SQLite, 1.5 GB and 1.5 CPU
caps, cron off) was installed, `tests/moodle-lab/setup.php` created the
fixture, and Chromium on the development computer reached it through an SSH
tunnel and the check's TLS proxy. The container, the pulled image and the
uploaded files were removed afterwards.

- **First run, Moodle 5.2.4:** failed at extraction. The grader keeps filling
  the student's form after it appears; the panel took that as a page change
  and the extraction in progress reported "the student, assignment or
  submission changed". Extraction is now repeated for the same student and
  attempt once the page has been quiet for 500 ms, up to three times.
- **After the fix, Moodle 5.2.4 (Build 20261005) and 4.5.12 (Build
  20260608):** all ten steps passed: sign-in, remembered site, detection of the
  statement, online text, PDF, "grade out of 10" and feedback field, the panel
  file list, the AI request carrying the PDF text downloaded from
  `pluginfile.php` with the teacher's session, grade and feedback applied,
  saved and still there after a reload, and "feedback applied, but not the
  grade" for the student whose grade is locked, both for an AI correction and
  a pasted one.

In that first fixture the feedback editor was a plain textarea.

The fixture and the check now go further. `setup.php` also creates, in the
same course, an assignment graded with a marking guide (two criteria out of 6
and 4, created with the grading manager and the guide controller) and one
graded with a custom scale ("Not yet, Approaching, Achieved, Excellent"), each
with an online text from the first student, and makes TinyMCE the teacher's
editor (first in `texteditors` and the `htmleditor` preference). Its JSON adds
`teacher_editor`, `guide` (cmid and criteria with id, grader row id and
maximum) and `scale` (cmid, scale id and items). The check then requires the
simple assignment's feedback to appear in TinyMCE before and after the save,
corrects the guide assignment with fake guide scores and asserts every score
input and remark, the "applied" status and, after saving and reloading, the
scores, the remarks and a gradebook grade equal to their sum, and corrects the
scale assignment with a fake scale item and asserts the select, the save and
the reload.

The extended check was run the same day on S1 the same way, on Moodle 5.2.4
and 4.5.12: all sixteen steps passed on both. TinyMCE kept the feedback after
saving and reloading; the guide scores (5 and 2), remarks and feedback were
saved and the gradebook showed 7; the scale item "Achieved" was selected,
saved and kept. The only change needed was in the check itself: Moodle lists
scale items from the highest down, so they are compared without order. The
container, the pulled image and the uploaded files were removed afterwards.
Moodle 5.0, 5.1 and 5.3 have not been run.

## Rendering fidelity

`npm run test:fidelity` reads 13 fictional documents, each as ODT and DOCX
converted by LibreOffice, and compares every page with LibreOffice's PDF of
the same file ([`rendering-fidelity.md`](rendering-fidelity.md)). The first
measurement found 4 of 26 renderings within the default thresholds and four
different page counts. Four causes were fixed:

- ODT proportional line spacing was relative to the font size instead of the
  font's line height, so lines were about 13% too tight;
- ODT tables aligned to the margins, with only relative column widths, came out
  about half the text width;
- a paragraph that did not fit moved whole to the next page; it is now split
  at the last line that fits, keeping at least two lines on each page, and a
  paragraph longer than a page continues over several pages instead of
  stretching one;
- a DOCX paragraph whose runs were all smaller than its style kept the style's
  line height.

Now 12 of 26 match within the default thresholds and three files differ in
page count. The remaining known differences (text wrapping around anchored
pictures and text boxes, text-box fill, ODT tab stops in headers, multi-column
sections, formula size, and residual line drift) are listed in the manifest
with their scores, so the check fails if any of them gets worse.

A second round fixed text wrapping around anchored pictures and text boxes,
text-box fill and outline, ODT tab stops, multi-column sections, ODT endnote
placement and the line drift at page ends (spacing at page tops and bottoms,
widow control, DOCX line height). Now 19 of 26 match within the default
thresholds and every page count matches; the 7 remaining differences are
described in [`rendering-fidelity.md`](rendering-fidelity.md).

These results use fictional documents. They do not establish layout accuracy
for every document, grading accuracy, or behaviour on every Moodle theme.

## Second round: grading methods, privacy, warnings and context

Requested with the condition that corrections must not become slow. Every
addition below is a single pass over text or over the laid-out page, with no
extra AI request.

### Grading methods

- **Marking guides** are filled: the AI returns a score and a remark for each
  guide criterion, bounded by the criterion's maximum in the Ollama schema,
  and the panel writes Moodle's score inputs and remark boxes. Moodle sums the
  scores. Frozen guides are refused before any field changes.
- **Scale grades** are filled: the AI chooses one of the scale's item labels
  (an enum in the schema) and the panel selects it. "No grade" is never chosen.
- Fixed on the way: the grade-input lookup matched a guide criterion's score
  input, so a real guide would have been read as direct grading.

### Privacy and safety

- **Student name.** The name Moodle shows for the student becomes `[Student]`
  in the online text, the extracted document text and the teacher criteria,
  and is covered with a black bar on PDF and Office page images. The full name
  matches in any case and in "Surname, Name" order; each capitalised name part
  of three or more letters matches as a whole word, also in capitals and
  without accents, so lower-case words such as "luna" or "río" are kept. The
  prompt says the name was replaced; `[Student]` in the reply is shown with the
  first name. On by default (Options → **Student name**). Not detected: names
  inside photos and scans, nicknames, misspellings.
- **Text addressed to the AI.** Visible sentences such as "ignore the rubric",
  "ponme un 10" or "note to the AI" (several languages) are listed for the
  teacher in the result, and the prompt reminds the model that they are
  evidence only. Nothing is blocked; the teacher decides.
- **Text under a picture.** Office text with 60% of each line covered by a
  picture drawn after it (slides) is left out as invisible.

### Ollama context and the plan

The correction prompt alone is over 4,096 tokens, Ollama's default context, so
with default settings Ollama refused the request (`truncate: false`). The
largest request of a correction is now estimated (3.5 characters per token,
800 tokens per image, 4,096 for the answer); when it exceeds the context the
model is loaded with, or the default when it is not loaded, every request of
that correction asks for a fitting `num_ctx`, capped at the model's maximum.
The panel shows the plan before the first request: pages, images, estimated
tokens and blocks.

`MCA_LIVE_EXTENSION_CONTEXT=1 node tests/live-office-check.mjs` keeps the
extension's own choice instead of the harness's 131,072. Against local
`gemma4:e4b` with the model unloaded: the first correction asked for 12,288,
the second found the model loaded with 12,288 and asked for nothing (no
reload). Both documents scored 10/10; the prompts were about 5,060 tokens.

### Speed

Measured in Chromium on fictional documents (three runs each, ms):

| Document | Every page as an image | Visual pages only (default) | Every page, name covered |
| --- | --- | --- | --- |
| ODT, 25 pages, 7 tables | 2,208 / 2,075 / 2,054 | 974 / 1,072 / 1,000 | 1,938 / 1,789 / 1,887 |
| DOCX, 18 text pages | 1,969 / 1,876 / 1,758 | 246 / 223 / 204 | 2,124 / 1,704 / 1,612 |

Encoding page images is most of the time. The invisible-text check, the
picture check and the name cover add no measurable time; sending text-only
pages as text makes reading 2 to 9 times faster.

### Not done

- **Preparing the next student in the background.** It would need Moodle web
  services that the grader does not expose to the panel, to save the one or two
  seconds of reading; the AI request takes tens of seconds and starts as soon
  as the next student's page is read.
- **ARM64 lab images.** The S1 runs use `erseco/alpine-moodle` directly; the
  published lab images stay amd64.
