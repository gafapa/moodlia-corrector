# Ollama request and data extraction fixes

Local candidate: 0.1.74, 27 October 2026. This follows a review of how the
extension extracts Moodle data and builds its Ollama requests. The full
contract is in [`ollama-request-pipeline.md`](ollama-request-pipeline.md).

## 1. Online text arrived shortened to 140 characters

**Problem.** Moodle's grader renders the submission status with
`assign_submission_status_compact`, which shows each submission plugin in
summary mode. For online text, `assign_submission_onlinetext::view_summary`
returns the text shortened with `shorten_text($text, 140)` plus a word count.
The renderer then adds the complete text in a
`.hidefull.full_assignsubmission_onlinetext_<id>` box, which `mod/assign/styles.css`
hides with `display: none` (checked in `MOODLE_405_STABLE`). The extension used
the first visible `.assignsubmission_onlinetext` element and `innerText`, which
skips CSS-hidden content. Unless the teacher had expanded the text first, the
model received about 140 characters and the word count. Images in the complete
text were also lost. Expanding or collapsing the text after extraction also
changed the grading-context snapshot.

**Fix** (`src/content/moodleContent.js`). `getOnlineSubmissionContent` looks for
the complete box inside the online-text container and reads it with a
layout-independent extraction (DOM clone, without `[hidden]` nodes or
expand/collapse icons). The result is the same whether the summary is expanded
or collapsed. Images are taken from the complete box, excluding Moodle UI icons
(`img.icon`, `.expandsummaryicon`). Without a complete box, the previous
visible-content behaviour is kept. Content inside `.attempthistory` is excluded
from online text and file links, so previous attempts are never read as the
current submission.

## 2. Ollama could silently truncate an oversized request

**Problem.** Requests do not set `num_ctx`, so the server context applies.
According to Ollama's documentation, the default depends on available VRAM. A
long statement, online text, rubric and evidence block can exceed it. Measured
against Ollama 0.40.11 with `num_ctx` 2,048, a 6,023-token request returned
HTTP 200 with only 1,027 prompt tokens evaluated: the server dropped most of the
input without any error. Token counts alone cannot detect this reliably,
because the truncated prompt can be far below the context size.

**Fix** (`extension/src/background.js`). Every Ollama chat request sends
`truncate: false`. With it, the same request returned HTTP 400: "request (6023
tokens) exceeds the available context size (2048 tokens), try increasing it",
in both streaming and non-streaming mode. The extension reports this as a
context overflow, suggests increasing `OLLAMA_CONTEXT_LENGTH` or reducing the
material, and applies no grades. Compatible (OpenAI-style) providers do not
receive the field. Ollama versions without `truncate` support ignore it.

## 3. Review notes reused original attachment numbers

**Problem.** Block-review notes had no source number, so
`formatDirectAttachments` gave them `attachmentNumber` 1, 2, 3... as
teacher-additional JSON. In synthesis, the model saw "attachment 1 is a
student PDF" in the receipt and "attachment 1 is teacher JSON" in the evidence.

**Fix.** Notes now carry role `ai-review-notes`, `evidenceType: review-notes`,
their own `notesBlock` number and `reviewedAttachmentNumbers`, and never an
`attachmentNumber`. The note text also records its review round.

## 4. Unsupported embedded images discarded whole documents

**Problem.** A DOCX or ODT with one EMF, WMF, GIF or SVG image (common in Word
equations, charts and pasted content) was rejected as unsupported, losing its
readable text.

**Fix** (`extension/src/attachments/reader.js`). PNG, JPEG and WebP are sent as
they are. GIF and BMP are converted to PNG locally with `createImageBitmap`.
Other formats are counted per format in `imageLimitations`, which the receipt
exposes as `omittedImages`. The model is told to mention that limitation when it
may matter, without inventing the images' contents. DOCX text now keeps tabs
and manual breaks and lists body text before notes, headers and footers (the
ZIP order is arbitrary). ODT text keeps tabs, line breaks and repeated spaces.

## 5. A long block note failed the whole correction

**Problem.** The block prompt asks for about 3,000 characters, but a note over
6,000 characters or with invalid JSON stopped the correction.

**Fix.** Such a note gets one text-only condensing request
(`evidence-notes-condense`), which does not resend the block or its images. If
the result is still invalid or too long, correction stops without grades as
before.

## 6. Contradictory and duplicated instructions

**Problem.** Block reviews used the final-correction system prompt ("produce a
grading suggestion" and "check the proposed grade before the final JSON") while
the user prompt asked for notes without a grade. Teacher criteria, the
attachment receipt and the synthesis instruction were sent in both the system
and user messages, using context.

**Fix.** The system message is phase-specific: block reviews "record evidence
notes" and get a notes checklist without a grade. Teacher criteria, the receipt
and the synthesis instruction appear only in the system message; the user
payload's `teacherCriteria` field only points to it.

## 7. Unrelated identifiers for the same file

**Problem.** The payload listed files as `submission-file-N` or `reference-N`,
while the evidence used `attachmentNumber`, with no link between them.

**Fix.** Submission, reference and teacher-file lists in the payload carry the
`attachmentNumber` of the prepared evidence. Online-text images are marked with
`source: online-text-image`.

## 8. Text files were read as UTF-8 only

**Fix** (`extension/src/attachmentSupport.js`). `decodeText` reads UTF-16 when
a byte-order mark is present, tries strict UTF-8, and falls back to
Windows-1252. Manual uploads, Moodle downloads and the offscreen reader use it.

## Not changed

- No `num_ctx`, `num_predict`, `think` or `keep_alive` is set; server and model
  defaults still apply. In the diagnostic probe, `gemma4:e4b` generated
  reasoning output by default, which the extension discards.
- The block limits (24,000 characters, four images) and processing limits are
  unchanged.
- The score's `minimum`/`maximum` and duplicate rubric criteria are still
  enforced by local validation after the response, not only by the schema.

## Validation

See the qualification snapshot in
[`ollama-request-pipeline.md`](ollama-request-pipeline.md#qualification-snapshot-27-october-2026).

## Review follow-up: 0.1.75

Three regressions in the Office reader were reproduced with fictional files
and fixed after the initial 0.1.74 review:

- ODT CDATA sections are now preserved as document text. The iterative XML
  walk also retains nested spans, tabs, manual breaks and repeated spaces.
- Repeated-space counts must be positive safe integers. The reader checks the
  remaining 600,000-character document budget before allocating spaces and
  counts all text, CDATA and paragraph separators towards that same budget.
  Oversized evidence fails explicitly instead of being shortened.
- DOCX and ODT readers pass the abort signal into image extraction. Cancellation
  is checked before each conversion and after decoding, is not swallowed as an
  unsupported-image warning, and stops subsequent conversions. Native bitmap
  decoding has no abort parameter: an in-progress decode must settle before
  its bitmap can be closed. Bitmaps and canvases are released in `finally`.

Validation: `npm run check` passed all 75 automated tests;
`npm run test:browser` passed, including the new extraction regressions in
`tests/attachment-reader-checks.mjs`; and `npm run test:locales` passed for all
eight locales. New cases cover exact and exceeded text limits, a billion-space
attribute guarded against allocation, invalid counts, CDATA, and cancellation
after image decoding, on decode rejection and after encoding in both formats.
The integration checks use fictional Moodle/provider fixtures. No new live
Gemma or production Moodle qualification was performed for this follow-up.
