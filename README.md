# MoodlIA Corrector

MoodlIA Corrector is a Chrome extension that helps teachers review Moodle assignment submissions and apply teacher-approved AI correction suggestions to Moodle grading forms.

## Structure

- `extension/`: Chrome extension source.
- `web/`: Reserved for product-specific static assets if they are still needed after `moodlia.com` is available.

The extension connects directly to Ollama running on the teacher's computer or to an OpenAI-compatible API selected by the institution. It does not require AI Runtime or any other browser extension.

Remote AI endpoints must use HTTPS, and provider requests do not follow redirects. Local Ollama endpoints may use loopback HTTP. API keys remain in Chrome session storage. Prompts omit student names, course names, Moodle page URLs, and submitted filenames; the assignment evidence and rubric still reach the selected provider and must be handled under the institution's privacy policy.

## Quality Checks

```bash
npm run check
```

The suite validates manifest assets, Moodle grader-page and attachment-origin restrictions, direct AI transport and configuration sanitization, correction parsing, rubric normalization, fallback behavior, privacy minimization, and prompt constraints.

## AI Connection and Local Evidence

Version 0.1.44 checks the configured server's model list instead of treating saved settings as a working connection. **Test connection** verifies generation with fictional data. Provider requests have a five-minute deadline; corrections can be cancelled from the panel or popup and have a ten-minute overall deadline. Incomplete AI output is retried once and rejected if it still cannot be reviewed safely.

Endpoint and model preferences survive service-worker restarts. Remote API keys are bound to their destination, held in session storage, and cleared when the provider or endpoint changes. Keys saved by older releases must be entered again because they have no destination binding.

Local Ollama requests use an extension-scoped Chrome session rule to remove the `Origin` request header on loopback HTTP only. This avoids Ollama's browser-origin rejection without changing environment variables, restarting Ollama, installing a proxy, or modifying requests from Moodle or other websites. Remote HTTPS requests retain their normal headers.

PDF and DOCX text is extracted locally using bundled PDF.js and fflate code. Scanned PDF pages, DOCX images, and PNG/JPEG/WebP attachments are sent as images to the selected provider. Ollama image requests require a model advertising vision support; compatible remote APIs must support image input. Unsupported, unreadable, or oversized files stop the correction rather than silently losing evidence. Limits: 4 MB per file, 10 MB total input, 60 PDF pages, 60,000 extracted text characters, and 12 images. Image interpretation is performed by the selected vision model, not a separate OCR service.

Build the bundled dependencies and run the Chromium integration checks:

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:browser
```

The browser checks use a temporary profile, fictional submissions, and a loopback test provider. To also verify the existing local Ollama installation with `gemma3:4b`, run `node tests/browser-check.mjs --live`. This sends a fictional connection probe and an arithmetic correction with one rubric criterion, not student work. It does not modify the machine's Ollama configuration.

Run `npm run package` to create `release/moodlia-corrector-0.1.45.zip` with the manifest at the archive root and all local parsing dependencies included.

## Assignment Supervision

Version 0.1.45 identifies the assignment title from the matching Moodle task navigation or activity heading instead of the course's `h1`. Linked assignment descriptions are parsed using a detached-document-safe text reader, with a bounded same-origin request.

The supervision panel lists files linked or embedded in the assignment description separately from submitted work. Each reference includes its filename, type, link description, and read status. Detection does not download these reference files or send their contents to AI; the panel states this explicitly. Submission extraction only includes submission file areas, and repeated file links are deduplicated. The browser regression fixture covers Moodle under a subdirectory, an editable ODT worksheet, encoded filenames, malformed links, and duplicate download links.

## License

Copyright (C) 2026 Pablo Gallego.

This project is free software released under the GNU General Public License version 3 or later. See `LICENSE`.
