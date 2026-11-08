# Changelog

## 0.2.6 - 2026-11-09

- **Correct when moving to the next student** did not start on Moodle's grader: the grader loads the next student in steps (the user, then the submission and files), each step reset the panel, and only the first reset saw a new student, so the later resets dropped the pending correction. The pending start now survives resets for the same student.
- **Correct when moving to the next student** no longer starts for a student who already has a grade in Moodle's form (a direct grade, a scale value, a selected rubric level or a marking guide score); the status line says so. Students corrected earlier on the page are still not corrected again.
- 1 new interface string in all eight languages.
- Store promotional tiles redesigned: the product name and one short promise beside a drawing of the compact grading panel, with little text and no format or provider lists.

## 0.2.5 - 2026-11-09

- Compact grading panel that fits a 720 px high window without scrolling:
  - the three steps (evidence, teacher criteria, result) collapse and show a summary when closed: files included and skipped, the save note, the grading mode;
  - each moment opens the step that matters: the criteria when a student loads, also the evidence when a file is skipped or none is found, and the result while and after correcting; the teacher can still open or close any step;
  - an open criteria or result step takes the free height, so the criteria field grows with the window;
  - evidence files sit in two collapsible groups, Teaching material (reference and supporting files, with Add supporting files) and Student submission; a group with a skipped file opens on its own, and the size limits move to the add button's tooltip;
  - the header puts the AI chip on the student line, the grading mode moves to the result step, and the status line moves to the footer above Correct with AI;
  - the per-scope hints move to the criteria tab tooltips;
  - 5 new interface strings in all eight languages.

## 0.2.4 - 2026-11-08

- OpenDocument files saved from LibreOffice Writer/Web, and master documents and templates (`text-web`, `text-master`, `text-template`, `spreadsheet-template`, `presentation-template` in the archive's `mimetype` entry), were skipped as "unsupported format content". They are now read like ODT, ODS and ODP, because their body is the same.

## 0.2.3 - 2026-11-07

- Redesigned grading panel:
  - the header shows the assignment and course, the student and attempt, the grading method, and an AI chip with the model in use that opens the AI settings;
  - the main view is three numbered cards: evidence for the AI (files grouped by role, unsupported files struck through with the reason, a button to add supporting files), teacher criteria in course / assignment / this-student tabs (a dot marks a scope with text) and the result;
  - while a correction runs, a progress card shows four stages and a progress bar;
  - **Correction JSON** and **Data and diagnostics** move to a **More options** menu; Escape closes the menu or the view and returns focus to the control that opened it;
  - the panel title is the product name, MoodlIA Corrector, in every language;
  - 14 new interface strings in all eight languages.

## 0.2.2 - 2026-11-07

- Lighter package and lower memory use:
  - bundle the minified PDF.js legacy build and leave out the unused QuickJS scripting engine and the no-WebAssembly decoder fallbacks (about 2.7 MB less in the extension package);
  - the content script carries only the translated strings, not the translators' descriptions (the injected script drops from 580 KB to 403 KB);
  - the offscreen document drops expired page images on a timer and is closed once nothing is cached or being read for two minutes;
  - the grading panel observes the page only while it is open, and checks for a changed student or page when it opens;
  - the assignment description page is downloaded once per assignment instead of once per student;
  - teacher criteria are saved when typing pauses (400 ms) instead of on every keystroke, and immediately on a student or page change.
- Store listing: say the interface is available in eight languages instead of listing them.
- Store listing: describe supported files in plain words instead of listing format acronyms (PDF, DOCX, ODT, XLSX, ODS, PPTX, ODP) in all eight localized descriptions, after a Yellow Argon keyword-stuffing rejection. Store validation now rejects descriptions naming three or more of those formats.

## 0.2.1 - 2026-10-28

- Render DOCX and ODT files as pages, like PDFs. Each page is laid out locally from the document's styles and sent as an image beside that page's text. The layout covers:
  - fonts (including Word theme fonts), colours, highlighting and alignment;
  - tables with merged cells, repeated header rows and Word table-style shading;
  - numbered and bulleted lists, including Word multilevel numbering, and heading numbers;
  - images, ODT formulas, and Word equations converted to MathML;
  - footnotes, and DOCX endnotes after the body;
  - headers and footers with page fields and Word tab stops;
  - first-page headers, and landscape page styles and sections.

  Pages follow the page breaks Word or Writer saved, or are measured when there are none. The receipt reports the page count; unsupported images, charts, SmartArt and linked images are marked on the page and counted; documents above 60 pages stop; a rendering failure keeps the previous text-and-images reading and is reported. Equations add a linear form to the text. See `docs/office-page-rendering.md`.
- Raise the decompressed-size guard for DOCX and ODT archives from 20 MB to 48 MB, so image-heavy documents within the new 20 MB file limit can be read.
- Read spreadsheets (XLSX, ODS) and presentations (PPTX, ODP) as student submissions and references, locally, like DOCX and ODT: page text beside a rendered page image, with the same limits, fallback, cancellation, hidden-text and invisible-text rules. Legacy XLS and PPT files remain unsupported. See `docs/office-page-rendering.md`.
  - Spreadsheets: each visible sheet is printed on landscape A4 pages with gridlines, column letters repeated on every page and row numbers; columns that do not fit continue on the following pages, and long runs of empty rows or columns collapse into one marker. Cells show their saved values with their number formats (decimals, percentages, thousands separators, dates and times), fonts, fills, borders, alignment and merges; anchored pictures and text boxes are drawn, charts are marked. The text lists each non-empty cell as `A1: value`, formulas as `B3: 12 (=SUM(B1:B2))`, and cell comments as `[Comment A1: ...]` (also printed under the rows, without author names).
  - Presentations: one page per visible slide at the slide size. Placeholders take their position and text style from the slide layout and master; master decorations, backgrounds, pictures (cropped), solid and gradient fills, outlines, common preset shapes, connectors, groups, bullets, numbering and tables (including PowerPoint's default table style) are drawn; charts, SmartArt and media are marked. The text starts with `[Slide N]`, follows the reading order (title first) and adds `[Speaker notes]`.
  - Hidden sheets, rows, columns (and values hidden by a `;;;` number format), hidden slides and hidden shapes are left out and counted as `hidden-text-excluded`. Text over a picture is checked for visibility against the picture's colour, so white titles on dark photos stay.
  - Limits: 10,000 non-empty cells per spreadsheet (ODS repeated rows and cells count every copy that holds content; empty repeats cost nothing), 200,000 drawn table elements, 60 visible slides, 5,000 shapes and 20,000 table cells per presentation.
  - Options: the page-image setting is now "Page images of Office documents (DOCX, ODT, XLSX, ODS, PPTX, ODP)". Prompts, the evidence receipt (format and page count) and text-only Ollama models handle the new formats like DOCX and ODT.
- Review fixes (`docs/review-2026-10-28-0.2.1.md`), document reading:
  - Bound the elements built from repeated ODT table cells and rows (200,000 per document): a nested table under 1 KB could hang the reader for minutes.
  - Leave hidden text (Word `w:vanish`, ODT `text:display="none"`) out of what is sent, as it is not drawn on the page, and count it in the receipt as `hidden-text-excluded`.
  - List each footnote once, on the page that cites it, including notes cited in repeated table header rows, and look notes up by id instead of scanning them.
  - Draw tables made only of header rows. Start the next page after a mid-paragraph Word page break. Drop invalid `w:sym` codes and control characters instead of failing the whole document. Leave moved-from tracked text out once. Leave DOCX `FILENAME` field results out of the page and the text.
  - List a header or footer on the first page that shows it, not only on page 1. Draw ODT endnotes after the body.
  - Measure the pages again when saved page breaks are stale (a saved page holding half a page more than fits).
  - Decode attachments without boxing every byte (a 20 MB file needed about 700 MB of memory), and wait for images with their load event in the offscreen document.
- Review fixes, correction:
  - Keep each page's text in the same review block as its page image, and cap the image data of a block at 32 MB so remote APIs accept the request.
  - With an Ollama model that reports no image input, send DOCX and ODT files as text without their page images (receipt: `page-images-not-sent`) instead of refusing the correction.
  - Raise the deadlines: two minutes per Moodle download, three minutes per local document read, 60 minutes per correction.
  - Refuse a correction request whose Moodle page URL differs from the page that sent it. Name files, not positions, in attachment errors. Keep a DOCX or ODT named `.pdf` as its real format in the receipt. Mention DOCX and ODT pages wherever prompts named only PDF pages, and stop asking for a "teacher notes" disclosure that had no field.
- Review fixes, Moodle panel:
  - Report "feedback applied, but not the grade" (or the reverse) when Moodle shows no editable grade field or feedback box, instead of "applied".
  - Escape feedback written to a plain-text Moodle editor (`FORMAT_MOODLE`), so text such as `<stdio.h>` is not removed when Moodle shows it.
  - Show the 20 MB / 40 MB limits next to the extra-files picker and flag an oversized selection before correcting; refuse extra text files above 600,000 characters before sending them.
  - Accept submission files only when the Moodle file component follows the context id in the URL.
  - Translate the remaining panel strings (summary, detected data, JSON hint, rubric controls, cost labels, errors) and fix "Mode: Mode:" in English.
- Raise the attachment limits from 4 MB per file and 10 MB in total to 20 MB per file and 40 MB in total. Each file crosses Chrome's 64 MiB runtime message limit on its own when it is read, and all manually added files cross it together (40 MB is about 53 MB of base64).
- Improvements after the review (`docs/improvements-2026-10-28-0.2.1.md`):
  - Leave out DOCX and ODT text that is drawn but cannot be seen: a colour too close to its background (contrast below 1.25), a size under about 2.6 pt, glyphs squeezed together, or text outside the page or a clipping box. The receipt counts it as `invisible-text-excluded`. Word page colours (`w:background`) and ODT page backgrounds are drawn, so light text on a dark page stays.
  - Put list and heading numbers (and bullets) in the extracted text, as drawn on the page: `1. Answer`, `1.1. Detail`.
  - Continue Word numbering across lists that share one definition without an override, and restart it for a list with a level override, as LibreOffice shows such documents (checked with four LibreOffice-converted cases). Previously each `w:num` counted on its own.
  - By default, send a DOCX or ODT page as an image only when it shows images, formulas, tables, drawings, borders, shading or struck-through text; a page with only text is sent as text and labelled "text only". Options has a "DOCX and ODT page images" setting to send every page. PDF pages are always images.
  - Draw a page much taller than its size (thousands of notes, a very long table row) as up to four images, top to bottom, instead of one shrunken image.
  - Encode a page as JPEG when its PNG is over 400,000 characters and the JPEG is under half that size (photos and scans), and keep typed pages in PNG.
  - Reuse the pages already drawn when the same file is corrected again with the same page-image setting: the offscreen reader keeps up to eight drawn documents in memory for 30 minutes, keyed by the file's SHA-256.
  - Show progress in the panel while correcting: downloads, reading each file, the model check, each evidence block, and writing the correction, with the elapsed seconds.
  - Add "Correct when moving to the next student" to the panel. With it on, the next student's correction starts once their data is read; a student already corrected on the page is not corrected again, and nothing is saved.
  - Fix the panel cancelling a correction after 30 minutes while the service worker allows 60.
  - Report "feedback applied, but not the grade" for an AI correction when Moodle shows its static "grade locked" element instead of a grade input (the AI is not asked for a score then), not only for pasted corrections with a score.
  - Repeat the extraction of assignment data, up to three times once the page is quiet, when a real Moodle grader is still filling the student's form: the panel took that as a page change and the first extraction failed with "the student, assignment or submission changed". Found by the real-Moodle check.
  - Layout fixes found by the fidelity check: ODT proportional line spacing (`fo:line-height="115%"`) is relative to the font's line height, not its size (lines were about 13% too tight and documents lost pages); ODT tables aligned to the margins span the text width, and columns with only relative widths share it; a paragraph that does not fit is split across pages with at least two lines on each (it moved whole, and long documents gained pages); a DOCX paragraph whose runs are all smaller than its style takes the largest run size. 12 of the 26 corpus renderings now match LibreOffice within the default thresholds (4 before).
  - Second round of fidelity fixes: anchored pictures and text boxes wrap the text (DOCX square, tight and through wrapping and ODT parallel, left and right wrapping become floats on their side, top-and-bottom stays a block, DOCX no-wrap and ODT run-through objects are placed over or behind their paragraph; a float that does not fit moves to the next page with its paragraph); text boxes draw their fill and outline (ODT `draw:fill-color` and `svg:stroke-color`, DOCX `a:solidFill` and `a:ln`, VML `fillcolor` and `strokecolor`) and no longer inherit the justification of their anchor paragraph; ODT centre, right and decimal tab stops are applied; multi-column sections (DOCX `w:cols`, ODT `style:columns`) are drawn in columns and continue on the next page without losing text; ODT endnotes start on their own page. Page ends: spacing above a paragraph or table moved to a new page is dropped, spacing below the last paragraph no longer pushes it over, ODT paragraph spacing adds up instead of collapsing, documents without widow control may leave one line on a page, `w:keepLines` and `fo:keep-together` keep a paragraph whole, DOCX automatic line spacing uses 1.15 (was 1.14), and empty DOCX paragraphs follow Word: one that closes a section keeps its line, and the empty rest of a paragraph after its page break takes a line on the next page in compatibility mode 15 (Word 2013 and later) and none in older modes. 19 of 26 renderings now match LibreOffice and every page count matches; the 7 remaining differences are explained in `docs/rendering-fidelity.md`.
  - `tests/attachment-reader-checks.mjs` checks the drawn pages for floating pictures and text boxes, a float moved whole to the next page, text box fill and outline colours, ODT tab stops and two-column sections (DOCX and ODT), including long sections over several pages.
  - Add `tests/live-office-check.mjs` (opt-in local inference with a fictional DOCX and ODT), `tests/moodle-lab-check.mjs` with `.github/workflows/moodle-lab.yml` (the extension against real disposable Moodle sites: simple direct grading, a marking guide, a scale, a locked grade and TinyMCE feedback), and `npm run test:fidelity` (our DOCX/ODT pages compared with LibreOffice PDFs over a fictional corpus).
- Privacy and safety (`docs/improvements-2026-10-28-0.2.1.md`):
  - Replace the student's name, as Moodle's grader shows it, with `[Student]` in everything sent to the AI: online text, extracted document text and teacher criteria. The full name matches in any case and in "Surname, Name" order; each capitalised name part of three or more letters matches as a whole word, also in capitals and without accents. The name is covered with a black bar on PDF and Office page images. The prompt says the name was replaced; `[Student]` in the AI's feedback is shown with the first name. On by default; Options → **Student name** turns it off. Names inside photos and scans are not detected.
  - Flag visible text in the student's work that addresses the AI or asks for a grade ("ignore the rubric", "ponme un 10", "note to the AI") in several languages. The correction result lists up to three excerpts per source for the teacher, and the prompt reminds the model that such text is evidence, never an instruction.
  - Leave out Office text covered by a picture drawn over it (60% of each line under one picture), as on slides; text drawn over a picture stays.
- Ollama context: the largest request of a correction is estimated before sending (3.5 characters per token, 800 tokens per image, 4,096 for the answer). When it exceeds the context the model is loaded with (`/api/ps`), or Ollama's 4,096-token default when it is not loaded, every request of that correction asks for `num_ctx` rounded up to 4,096 and capped at the model's maximum (`/api/show`). One size per correction avoids reloading the model between requests. With Ollama's default settings, a correction prompt alone exceeded 4,096 tokens and failed.
- The panel shows the plan before the first AI request: pages, images, estimated tokens and evidence blocks.
- Fill Moodle marking guides. The AI returns `guideScores` (`criterionId`, `score`, `remark`) for every guide criterion; the Ollama schema fixes the criterion ids and bounds each score between 0 and the criterion's maximum, and incomplete or out-of-range scores need repair. The panel writes each criterion's score input and remark box; Moodle sums the scores into the grade, so no grade input is written. A frozen, review or view guide (grade locked or overridden in the gradebook) is refused before any field changes, like a frozen rubric. Guide score inputs are no longer mistaken for the grade input.
- Fill scale grades. The AI chooses `scaleGrade` from the visible labels of Moodle's scale select (an enum in the schema, without "No grade"), and the panel selects that item. Without a choice the select, including "No grade" (`-1`), is left as it is; an unknown label is refused before any field changes.
- The correction result shows a warning listing student text addressed to the AI (with its file or "online text"), a note with the number of name replacements when the student's name was pseudonymized, the guide total and per-criterion scores, and the proposed scale item. The plan stays in the result area while the correction runs.

## 0.1.77 - 2026-10-27

- Key student/attempt ("case") teacher criteria by the real Moodle user. Inside the grader, the hidden `userid` input is `0` for every student, so all students previously shared one set of case criteria; the user now comes from the grade form's `_qf__mod_assign_grade_form_<userid>` marker or the grader URL. Attempt `-1` (latest) resolves to the real attempt number, so a reopened attempt no longer reuses the previous attempt's criteria. Criteria saved under the shared key are not migrated.
- Keep scanned and photographed PDF pages within Chrome's 64 MiB message limit: pages whose PNG exceeds 1.2 MB of base64 are encoded as JPEG, and a PDF whose page images exceed 48 MB stops with an explicit error. The receipt reports no extracted text for pages without a text layer.
- Accept only Moodle submission file-area links as submitted files, excluding plagiarism reports and portfolio buttons in the same file row. Online-text images must come from the online-text file area.
- Refuse to apply a frozen Moodle rubric (locked or overridden gradebook grade) instead of reporting levels Moodle will not save.
- Write editor feedback as escaped HTML paragraphs into both the textarea and TinyMCE, preserving line breaks and treating `<`/`&` in feedback as text.
- Treat a returned `maxScore` on another scale as a correction that needs repair; `studentFeedback` takes precedence over legacy feedback keys. The prompt's score template is a placeholder instead of the example `7.5`.
- Read DOCX text boxes once (without their VML fallback copy), keep non-breaking hyphens and symbols, and report charts, SmartArt and embedded objects. Read ODT frames and notes once and exclude comments, tracked deletions and alt text.
- Identify PDF, DOCX, ODT, PNG, JPEG and WebP from their bytes. A renamed legacy `.doc` is skipped as unsupported instead of stopping the correction, images use their real type, and a teacher file without an extension is read as text.
- Detect UTF-16 without a byte-order mark, and measure decoded text against its original byte size.
- Show grading-guide and scale modes as filled manually, and detect translated "grade out of" labels.
- Stop typing during the load of saved criteria from overwriting them; label criteria results by identity; give the AI suggestion field an accessible name.
- Bind each settings-frame token to the first frame that uses it and post its messages to the exact parent origin. Moodle-page content scripts can only switch between saved AI servers and models and cannot change remembered sites.
- Ignore SSE `id:`/`retry:` fields, accept Ollama versions that do not report model capabilities, and redirect final-grade wording to notes during evidence review.
- Translate 44 provider and download errors and the page titles into all eight interface languages, and stop repeated English sources from merging different translations.
- Exclude documentation, source maps and hidden files from the extension package.
- Update the privacy policy for filenames mentioned in teacher criteria and copied course/assignment defaults.

## 0.1.76 - 2026-10-27

- Bound non-streaming AI response bodies to 8 MB and generated content to 200,000 characters; reject interrupted compatible JSON completions as well as interrupted streams.
- Measure attachment content when enforcing file and aggregate byte budgets, rejecting invalid declared sizes instead of trusting missing or understated metadata.
- Preserve complete evidence-note input during condensing instead of silently dropping everything after 60,000 characters.
- Validate locked Moodle feedback and rubric controls before changing grading fields; do not force disabled inputs into a selected state.
- Exclude explicitly hidden online images while retaining the full submission box hidden by Moodle's own summary UI.
- Check GIF/BMP dimensions before decoding, report oversized embedded images in the receipt, and enforce Office image counts before further conversion.
- Discard stale provider-profile lookups so rapid provider changes cannot mix a previous provider with the latest provider's endpoint.
- Add regression coverage and a complete local review report in `docs/review-2026-10-27-0.1.76.md`.

## 0.1.75 - 2026-10-27

- Preserve XML CDATA in ODT paragraphs alongside ordinary text, tabs and line breaks.
- Check the cumulative ODT text budget before expanding repeated spaces, including paragraph separators, and reject invalid repetition counts without allocating oversized strings.
- Propagate cancellation through DOCX/ODT image extraction. Stop subsequent conversions, preserve the cancellation error, and release decoded bitmaps and temporary canvases even when conversion fails or is cancelled.
- Add real Chromium regressions for text preservation, exact and exceeded text limits, invalid counts, and cancellation during image decoding and encoding in both Office formats.

## 0.1.74 - 2026-10-26

- Separate evidence-block observation prompts from final correction and repair prompts. Native Ollama corrections now use a rubric-aware JSON schema instead of JSON syntax alone.
- Preserve online submission paragraphs, code indentation and same-origin inline images; report omitted image URLs and deduplicate download variants.
- Reject PDF/login-page substitutions, resolve generic download names from response metadata, recognize unnamed octet-stream PDFs, and keep document parsing ahead of misleading text MIME types.
- Retain original filenames locally for explicit teacher references while omitting unmentioned names, file URLs, selected rubric levels and DOM values from inference payloads.
- Stop offscreen PDF work on cancellation/deadline, reject truncated Ollama responses, and retain token counts, durations and stop reasons without storing reasoning output.
- Document the full extraction and HTTP contract in `docs/ollama-request-pipeline.md` and expand the fictional local/browser regressions.
- Read the complete online text from Moodle's hidden `full_assignsubmission_onlinetext` box. The grader shows only a 140-character summary unless expanded, so corrections previously received a shortened submission. Images inside the complete text are included; Moodle UI icons are excluded. Attempt-history content is never read as the current submission.
- Send `truncate: false` to Ollama so an oversized request fails with a context error instead of being silently cut by the server. The error explains how to increase the context; no grades are applied.
- Number AI block notes by `notesBlock` with the `ai-review-notes` role, so they no longer reuse an original `attachmentNumber` with a different role and format during synthesis.
- Keep DOCX/ODT text when an embedded image cannot be supplied. GIF and BMP images are converted locally to PNG; EMF, WMF, SVG, TIFF and other formats are reported as `omittedImages` in the document receipt instead of excluding the whole document. DOCX text keeps tabs and manual line breaks and lists the body before notes, headers and footers.
- Condense an invalid or oversized evidence-block note once with a text-only request instead of failing the correction.
- Send teacher criteria, the attachment receipt and the synthesis instruction once, in the system message. Evidence-block reviews get their own phase instructions, without the final-grade checklist. Listed submission, reference and teacher files carry the `attachmentNumber` used by the evidence.
- Decode text and source files as UTF-8, UTF-16 with a byte-order mark or Windows-1252, instead of UTF-8 only.
- See `docs/ollama-request-fixes-2026-10-27.md`.

## 0.1.73 - 2026-10-26

- Preserve a trusted original-document receipt through PDF block review, final synthesis and schema repair, including document role, format, page count and supplied representations.
- Mark intermediate observations as derived review notes and map them back to original attachment numbers, preserving student authorship separately from the notes container.
- Explain PDF text/image transport explicitly so the absence of native PDF binaries or original images during synthesis is not treated as a missing submission. Preserve specific unreadable-evidence limitations.
- Add an opt-in nine-page PDF receipt check against an installed local vision model, using isolated Chromium and fictional evidence.

## 0.1.72 - 2026-10-26

- Keep extracted PDF page text beside its corresponding rendered image during evidence-block review, preserving original attachment numbers and every character.
- Stop evidence-note reduction if it fails to shrink or exceeds four rounds, instead of repeating until the overall operation deadline.
- Record review rounds and block counts in local diagnostics without recording document contents.
- Cover multi-page PDF extraction, page-aligned provider payloads, and non-converging notes with synthetic regressions.

## 0.1.71 - 2026-10-24

- Commit the immutable selected provider configuration so concurrent status reads cannot restore the previous provider during a save.

- Expand source-code evidence support across C/C++ headers, JavaScript/TypeScript modules and components, shells, common programming languages and text configuration formats.
- Decode source uploads as inert text, including base64 input, and detect linked source files in assignment references. Existing attachment limits and skipped-format reporting apply.
- Synchronize store materials across all eight locales and remove the rejected provider-brand enumeration. Validate generated kits and copy pages, refresh intact generated copies and preserve publisher edits on conflict.

## 0.1.70

- Render every PDF page as visual evidence alongside extracted text instead of filtering pages through graphics-operator heuristics.
- Increase page rendering to scale 2 with a 2400-pixel longest-edge cap, and preserve PDF page numbers through image batching and provider prompts.
- Explicitly require visual inspection in direct corrections and intermediate evidence reviews.
- Verify embedded raster pixels in the real Chromium provider payload and test page mapping across both provider schemas.

## 0.1.69

- Move correction and connection-test requests to runtime ports with client heartbeats, avoiding a single long-lived asynchronous message response channel.
- Cancel work when its requesting port disconnects and report worker disconnection without replaying the AI request.
- Align the overall correction deadline with the client deadline of 30 minutes; retain the 15-minute limit per AI request.
- Cover port responses, heartbeat cleanup, worker disconnection, deadline cancellation, and real Chromium correction flows.

## 0.1.68

- Review large attachment sets in bounded evidence blocks and combine their notes before grading, preserving all extracted characters, images, roles, and source numbers.
- Support up to 600,000 extracted attachment characters and 120 images while retaining download and decompression safeguards.
- Consume Ollama and compatible OpenAI generation streams, reject interrupted responses, and allow cancellable requests up to 15 minutes.
- Add regression coverage for large evidence, fragmented streams, cancellation, and invalid intermediate reviews.

## 0.1.67 - 2026-10-21

- Bundle localization and grading dependencies into the stable content-script entry point. Old persisted registrations no longer start the grader without `MoodliaCorrectorI18n` while background synchronization is pending.
- Ignore assignment overview pages before initializing any content runtime. Preserve manual activation, remembered installations and the selected interface language.
- Keep editable grader source in `src/content/moodleContent.js`; regenerate the packaged entry point with `npm run build`. Packaging rejects an outdated bundle.
- Add Chromium regressions using a legacy registration without localization files, covering both overview and grader pages, plus registration migration coverage.

## 0.1.66 - 2026-10-20

- Preserve the initialized interface-language runtime when content scripts are manually injected again. Repeated activation no longer resets saved language to the browser default.
- Add a regression with an English browser and Spanish preference, covering the cross-platform CI failure hidden by a Spanish Windows browser.
- Read the current version and validation counts when generating submission materials instead of hard-coding the previous candidate.

## 0.1.65 - 2026-10-20

- Add bundled English, Spanish, French, German, Portuguese, Italian, Galician, and Catalan interface catalogs with native Chrome metadata localization.
- Follow the browser language by default and allow a saved interface-language choice in Advanced settings. Keep Moodle page language, teacher text, filenames, and AI feedback separate from interface translation.
- Translate toolbar, grading workflow, file roles, statuses, provider controls, and Advanced settings without remote translation services. Preserve interpolated content as text.
- Add catalog/placeholder parity checks, browser coverage for all eight locales, reproducible fictional store screenshots, and a Chrome Web Store submission kit.

## 0.1.64 - 2026-10-19

- Promote all three teacher-criteria scopes into explicit system guidance in both generation and schema repair. Retain compatible broader instructions and prefer the more specific scope for conflicts.
- Let explicit teacher language, detail, and formatting preferences override generic feedback defaults.
- Honor teacher-declared delivery assumptions and waivers consistently across overall feedback and rubric selections, without claiming to inspect unavailable files or extending an assumption to unrelated deliverables.
- Verify exact criteria transport, scope serialization, missing-ZIP acceptance guidance, and preservation during a real request/repair sequence using a fictional provider.

## 0.1.63 - 2026-10-19

- Widen the toolbar popup from 340px to 480px and set an explicit root minimum width so Chrome can size the action window reliably.
- Increase text size and spacing for site actions, URL entry, and saved-site rows. Preserve the two-action toolbar workflow.
- Verify popup dimensions and horizontal overflow alongside the existing isolated browser checks.

## 0.1.62 - 2026-10-19

- Limit the toolbar popup to Add site and Manage sites. Keep correction, file previews, teacher criteria, and AI configuration in the Moodle sidebar.
- Add HTTPS Moodle installations from their base URL or assignment URL, list saved installations, and remove automatic activation independently for each site.
- Keep manual sidebar activation when opening the icon on a grader and allow site management outside grading pages.
- Verify site registrations, removal, compact popup presentation, and sidebar instruction persistence with isolated browser fixtures.

## 0.1.61 - 2026-10-19

- Move the complete options workflow into the grading panel's Advanced mode, while Simple offers all named providers and searchable model selection with refresh/test/cancel actions.
- Reuse the options document in a tab-authorized extension-origin frame. Isolate key fields from the Moodle DOM; verify origin/window/token for sizing; keep mode controls visible while scrolling.
- Restore per-provider profiles in Simple and update model controls after advanced saves. Reject stale status requests, cancel connection tests on context changes, and recreate hidden frames after external settings changes.
- Match MoodlIA Rubrics' activation workflow: manual activation from the icon, optional remembered automatic activation per Moodle installation, and an off switch. Replace static automatic injection with persistent dynamic registrations. Keep AI/download network permissions separate and retain them for existing transport behavior.
- Make reinjection idempotent, keep the popup available outside grader pages, remove the unnecessary tabs permission, and verify remembered activation across reloads and removal.
- Wait briefly for delayed redirect-header events before removing the temporary attachment listener, avoiding an opaque-redirect race.

## 0.1.60 - 2026-10-19

- Add named llama.cpp, LocalAI, and vLLM providers alongside Ollama and LM Studio. Every provider exposes synchronized protocol, IP/hostname, port, API path, and full URL fields; IPv4 and IPv6 are supported.
- Retain separate non-secret endpoint/model profiles for each provider. Secrets remain session-only and are cleared when the active destination changes.
- Allow HTTP for configurable local-server providers on another machine. Chrome grants access only to the selected HTTP host through a user-initiated optional permission request. Refusing access leaves the saved configuration unchanged. Remote API mode still requires HTTPS.
- Extend the extension-only Origin workaround to the configured HTTP server origin and remove that rule when changing destinations. Website requests and host CORS/environment settings remain unchanged.
- Replace model autocomplete with a searchable, keyboard-operable list showing readable names, available parameter/quantization/size metadata, counts, empty states, and an editable exact model ID. Sort models and deduplicate IDs. Add model search and richer model labels to the grading panel.

## 0.1.59 - 2026-10-19

- Add LM Studio as an explicit provider with a loopback `/v1` endpoint, optional session authentication, model discovery, JSON corrections, and compatible image content parts.
- Add a generic local compatible-server option for llama.cpp, LocalAI, and vLLM endpoints. Keep HTTP restricted to loopback addresses and retain HTTPS/API-key requirements for the remote provider.
- Add model suggestions and a model-list action in AI settings. Changing providers selects the corresponding default endpoint and clears the previous model and key input.
- Share provider definitions between settings and the worker, show readable provider names in the panel, and prevent a delayed initial settings response from overwriting user edits.
- Cover local compatible model discovery, empty model lists, generation, image payloads, optional authentication, persistence, and provider/key isolation with regression tests. No local AI application is installed or reconfigured.

## 0.1.58 - 2026-10-19

- Replace the 250 ms rendered-text polling loop with debounced DOM/navigation events and a 1-second scalar-property fallback; disconnect observation and stop timers outside the grader.
- Share correction validation between background and content scripts, preserve repair flags, report manual JSON failures in the panel, and reject malformed popup JSON without turning it into feedback.
- Require explicit rubric criterion identities. Manual JSON may specify an explicit criterion number/index; AI output must use the detected IDs. Never infer criterion identity from array position or fuzzy text. Check the current rubric and maximum in the local grading-context snapshot before applying.
- Encode attachment text and image-role metadata as a JSON envelope. Document text cannot introduce sibling role records through raw delimiters. This is a structural boundary, not a guarantee against semantic model prompt injection.
- Limit content script matching to assignment-view paths instead of every HTTPS page. Keep the runtime grader guard.
- Add a button to remove the session API key and normalize legacy secret destinations before comparing them.
- Follow up to five HTTPS attachment redirects, including signed external storage. Validate every hop, detect loops, and omit credentials outside the original Moodle origin. Keep AI-provider redirects disabled.
- Add read-only `webRequest` permission to resolve opaque manual redirect locations for downloads initiated by this extension; remove each temporary listener after the request.
- Remove obsolete content-script transport/prompt/parser code. Share attachment limits, binary encoding, and manual upload reading across extension contexts.
- Verify bundled library bytes against installed dependencies and reject missing assets or invalid UTF-8 before packaging. Add accessible names to popup textareas.

## 0.1.57 - 2026-10-19

- Omit unsupported attachment formats while continuing correction with supported evidence. Share format classification across the background worker, local reader, panel, and popup.
- Mark omitted files red with a textual reason and show included/omitted counts. Return unsupported embedded-format findings from the local reader to the preview.
- Skip known unsupported downloads/uploads before reading bytes or applying their size to supported-upload limits. Exclude their content and filenames from provider attachment payloads, while reporting omitted roles as evidence limitations.
- Keep malformed, inaccessible, oversized, or timed-out supported attachments as explicit errors rather than treating them as unsupported.
## 0.1.56 - 2026-10-19

- Copy the latest course and assignment criteria into contexts without saved criteria in the same Moodle installation. Preserve existing values, including deliberately empty ones; never copy concrete-case criteria.
- Compact file previews into grouped filename rows, with purpose stated once per group and an accessible, height-limited scrolling area for long lists.
- Move grading mode and detection status below the tool icons, with stronger type and contrast.
- Add regressions for persistent default copying, existing/empty criteria preservation, cross-site isolation, compact previews, and header order.
## 0.1.55 - 2026-10-19

- Split teacher criteria into course, assignment, and individual student/attempt scopes in both the side panel and popup.
- Persist and synchronize each scope with its Moodle site/installation context. Restore only matching criteria after navigation; unavailable contexts keep their fields disabled.
- Send the three criteria separately to AI, applying course guidance before task and case refinements while retaining Moodle rubric precedence.
- Preserve legacy global instructions and provide an explicit copy-to-current-task action instead of assigning old text to every scope.
- Add context-isolation, attempt, navigation, AI payload, and legacy-recovery regressions.
## 0.1.54 - 2026-10-19

- Simplify the side panel to file purposes, persistent teacher instructions, and a readable correction result. Move AI settings, correction JSON, and captured data/diagnostics behind three labelled SVG icon buttons.
- Add expanded-state announcements, control relationships, keyboard focus styling, Escape/back navigation, and focus restoration. Preserve all existing technical controls in their dedicated views.
- Present proposed grades and feedback without raw JSON or provider/debug counters in normal success messages. Navigation clears the result and returns to the main workflow.
## 0.1.53 - 2026-10-19

- Handle rejected action-title updates when a tab closes between its lifecycle event and the Chrome API call. Consume enable/disable and title results together, including synchronous failures, and reject invalid tab IDs before calling Chrome.
- Add unit regressions and an isolated Chromium check using a genuinely closed tab to prevent unhandled `No tab with id` rejections.
## 0.1.52 - 2026-10-19

- Show a file preview in the panel and popup before correction, including each filename and its purpose: assignment reference, student submission, or teacher-supplied additional material.
- Update the preview after extraction, manual file selection, and page resets. Show original submission names locally while keeping provider prompts anonymized.
- Explain that planned attachments are validated when correction starts, and identify online submission text separately from files.
## 0.1.51 - 2026-10-19

- Read task-description documents when requesting correction, separately from student submissions. Detection alone still does not download files.
- Label assignment references, student work, and manually supplied teacher material throughout attachment preparation and AI prompts, including image positions and repair requests. Reference contents must not receive credit as student work.
- Add local ODT text and embedded-image extraction, with existing byte, expansion, text, and image limits. Unsupported or inaccessible reference material stops correction.
- Cover role separation, local reference downloads, ODT extraction, image attribution, and malformed or inaccessible documents with fictional regressions.
## 0.1.50 - 2026-10-19

- Automatically save additional correction instructions in extension-local storage and restore them after page or browser restarts.
- Preserve saved instructions across page/student resets and synchronize the side panel and popup. Clearing the field saves an empty value.
- Serialize local writes and avoid overwriting text entered while initial preferences are loading. Add persistence, synchronization, navigation, and clearing regressions.
## 0.1.49 - 2026-10-19

- Reset per-page assistant state when the URL, student, attempt, or submission changes, including Moodle navigation without a document reload.
- Cancel pending AI requests and clear correction JSON, generated suggestions, additional instructions, attachments, and detected context. Preserve AI preferences and Moodle form fields.
- Refresh detected data when the panel remains open. Reject old requests and extractions after navigation, including returning to the previous URL.
- Reset on page exit and browser-cache restoration; add browser regressions for navigation during generation, clean controls, fresh corrections, and full reloads.
## 0.1.48 - 2026-10-19

- Preserve the body's original positioning when reserving room for the AI panel. Moodle themes using `#page { position: inherit; }` no longer create a one-pixel positioning area that collapses the document and grading regions.
- Extend the browser fixture with the real inherited-position structure and assert usable region heights and bottom action placement at three viewport widths.

## 0.1.47 - 2026-10-19

- Detect simple direct grading and read its maximum from the associated Moodle label when the text field has no `max` attribute.
- Display the detected grading method in the side panel and popup as soon as they open.
- Reserve space beside the AI panel for the entire Moodle page, including absolute grading regions and fixed navigation or action bars. Restore the page layout on close and adapt both widths on resize.
- Add Chromium regressions for localized maximum labels, TinyMCE feedback, mode detection, responsive positioning, and layout restoration.

## 0.1.46 - 2026-10-19

- Reject stale corrections after a student, assignment, attempt, or submission changes, including navigation during AI generation.
- Validate manual scores before any form edits; reject invalid rubric indexes instead of silently substituting the lowest level.
- Require valid criterion selections and criterion-specific feedback before accepting an AI correction as complete.
- Preserve text and visual evidence together on PDF pages containing graphics.
- Replace silent 12,000-character truncation with explicit statement and online-text limits.
- Enforce Moodle attachment download limits while reading the stream.
- Add browser and unit regressions using fictional submissions.
