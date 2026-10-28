# PDF receipt and synthesis fix

Local candidate: 0.1.73, 26 October 2026.

The reported symptom was that the model said the PDF had not been supplied,
rather than a timeout or context allocation error. The initial diagnosis in
`pdf-context-diagnosis-2026-10-26.md` did not reproduce that specific symptom.

## Relevant defect

Large documents are reviewed in separate requests. The final request previously
contained JSON notes labelled as teacher-added material, with no structured
receipt connecting those notes to the original PDF or student authorship. The
native PDF binary is never included in the chat API: Corrector sends extracted
text and rendered page images. Treating only a native PDF attachment or directly
visible original images as proof of submission could therefore produce a false
missing-document claim, especially during synthesis or schema repair.

## Changes

- Build an original-document receipt from successfully prepared local evidence.
  Preserve attachment number, original role, format, page count, representation
  types and image counts throughout review, synthesis and repair.
- Mark intermediate observations as `review-notes`, with application-generated
  original attachment numbers. The notes container does not change student work
  into teacher-authored material. Notes remain untrusted derived evidence.
- Explain the text/image representation explicitly. Missing original images in
  the synthesis request do not establish missing delivery. Specific unreadable
  content and uncertainty still need to be reported; receipt is not proof of
  correctness or fulfillment of a rubric requirement.
- Preserve existing filename privacy, excluded-format behavior, teacher criteria
  and page alignment. Only explicitly teacher-mentioned names are disclosed.

## Validation

- `npm run check`: 67 tests passed, including original receipt propagation across
  both transports and schema repair, role separation and empty receipts.
- `npm run test:browser`: passed. A real nine-page PDF is rendered locally and
  its receipt and provenance survive three simulated block reviews and final
  synthesis.
- `node tests/live-pdf-check.mjs`: passed against installed `gemma4:e4b`, with
  per-request context 131,072. The real extension fetched a generated nine-page
  PDF from an intercepted fictional HTTPS Moodle URL, rendered and reviewed its
  pages, and synthesized the result after four model requests in 74,908 ms.
  The final request contained no original images; its receipt still identified
  the document as a nine-page student-submission PDF. The model awarded the
  expected 10/10 and explicitly recognized the supplied document's contents.
- The local model's final feedback was: "Your submission successfully includes
  the required sentence, \"Fictional PDF evidence,\" on multiple pages (e.g., Page
  5, Page 6, Page 7, Page 8, and Page 9). This confirms the presence of the required
  text and meets the criteria for full credit."
- `npm run package`: generated `release/moodlia-corrector-0.1.73.zip`.

The live harness uses an isolated headless Chromium profile and fictional data.
It overrides context for its intercepted inference requests only, without
changing Ollama server settings. It does not use the user's open Moodle session
or change any grades. The test verifies this synthetic document and model run;
it does not prove arbitrary PDFs cannot trigger a similar model error. The
user's original PDF was not available for reproduction.

The candidate is packaged locally, not published or installed into the user's
active browser. Reload the updated extension and Moodle tabs before retesting.
