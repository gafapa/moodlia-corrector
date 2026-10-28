# Large PDF and Ollama context diagnosis

Date: 26 October 2026. Local candidate: 0.1.72.

## Findings

The selected model is `gemma4:e4b`. The installed model advertises vision and a
131,072-token maximum context. The local server was configured with
`OLLAMA_CONTEXT_LENGTH=65536`; a real extension connection test confirmed an
allocated context of 65,536 tokens. Corrector does not send `options.num_ctx`, so
the server configuration applies. A maximum context advertised by a model is not
the same as its allocated context.

An explicit 131,072-token diagnostic request succeeded too. This does not support
attributing the reported problem to a basic incompatibility with 128K context.
The original failing PDF and exact error were not provided, so its failure has
not been reproduced.

PDF processing retains independent limits of 4 MB per file, 10 MB total input,
60 pages per PDF, 600,000 extracted attachment characters and 120 images.
Extraction has a 60-second deadline; provider requests have a 15-minute deadline,
and the overall correction has a 30-minute deadline.

Every PDF page is rendered as an image, including text-only pages. Evidence
blocks are limited to 24,000 characters and four images, regardless of context
length. A 60-page PDF requires at least 15 visual review requests and one
synthesis request. More text, intermediate reduction, or schema repair can add
requests. Assignment instructions and rubric are repeated in each request.
Increasing context alone does not remove these costs or limits.

## Changes

- Retain page text offsets from the PDF reader and split evidence by page before
  applying block limits. Previously, short text for all pages could accompany
  only the first four page images, leaving later visual blocks without their
  corresponding extracted text. Every original character, image and attachment
  number is retained. An unusually long individual page may still span text
  fragments.
- Stop note reduction when it fails to shrink, or after four review rounds.
  Escaped JSON notes can otherwise settle into repeated reduction requests.
  Failures do not apply Moodle grades.
- Record review round and block counts in local diagnostics, without recording
  document contents.

Existing teacher-criteria changes in the working tree were preserved. No server
environment settings, model files, installed browser profiles, or Moodle grades
were changed. Explicit context overrides below were diagnostic requests only.

## Validation

- `npm run check`: 65 automated tests passed, including page alignment and
  non-shrinking escaped notes.
- `npm run test:browser`: passed in isolated headless Chromium. A generated
  nine-page PDF reached a simulated provider through three page-aligned reviews
  and a final synthesis. Existing embedded-raster pixel checks also passed.
- `npm run package`: generated `release/moodlia-corrector-0.1.72.zip`.
- Live extension connection test against local Ollama: `gemma4:e4b`, successful
  JSON response in 31,354 ms including model loading; allocated context 65,536.
- Explicit 128K local API text test: HTTP 200, valid JSON, 12,178 ms including
  10,416 ms model loading; allocated context 131,072, normal stop.
- Explicit 128K local API visual test using Corrector's generated messages:
  four fictional PNG pages at 1191 x 1684 pixels, HTTP 200, complete correction
  JSON in 22,232 ms, 5,916 prompt tokens, 763 generated tokens, normal stop.
  This used a 2,048-token output cap; the extension normally does not set that
  cap. It validates one synthetic visual block, not a complete large-PDF
  correction, native PDF understanding, or student-assessment quality.

The server reported full GPU placement during these short diagnostics. The
machine has 8 GiB VRAM and approximately 32 GiB system RAM. GPU discovery timeout
warnings exist in older server logs, but no evidence connects those warnings to
the user's specific PDF failure. No out-of-memory cause was established.

Package SHA-256:
`3BEE02F08338E1268C2775094AB7419E846B7D13EBF667FAAD544F9D56991244`.

This candidate was packaged locally, not published or installed into the user's
active browser. Reload the updated extension and Moodle tabs before retesting.
The exact error, original PDF page count and byte size are still needed to
identify which limit or runtime stage affected the reported case.

## References

- [Ollama context allocation and memory](https://docs.ollama.com/context-length)
- [Gemma 4 model capabilities and context](https://ollama.com/library/gemma4)
