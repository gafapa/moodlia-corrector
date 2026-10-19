# MoodlIA Corrector

MoodlIA Corrector is a Chrome extension that helps teachers review Moodle assignment submissions and fill editable Moodle grading fields with AI suggestions. The teacher reviews those suggestions and decides whether to save the Moodle form.

## Structure

- `extension/`: Chrome extension source.
- `marketplace/`: localized store listings, screenshots, privacy statements, and submission instructions.
- `scripts/`: reproducible localization, packaging, and publication-page generators.
- `release/`: generated archives and extracted publication materials; ignored by Git.

The extension connects directly to Ollama running on the teacher's computer or to LM Studio, llama.cpp, LocalAI, vLLM, another compatible local server, or an OpenAI-compatible API selected by the institution. It does not require AI Runtime or any other browser extension.

Remote AI endpoints must use HTTPS, and provider requests do not follow redirects. Local-server modes may use HTTP on loopback or an explicitly permitted network host. HTTP on a LAN is unencrypted; use HTTPS for sensitive network traffic. API keys remain in Chrome session storage. Prompts omit the structured student-name, course-name and Moodle-page-URL fields and submitted filenames; text and documents may still contain identifying information, so this is not guaranteed anonymization. The assignment evidence and rubric still reach the selected provider and must be handled under the institution's privacy policy.

## Quality Checks

```bash
npm run check
```

The suite validates manifest assets, Moodle grader-page and attachment-origin restrictions, direct AI transport and configuration sanitization, correction parsing, rubric normalization, fallback behavior, privacy minimization, and prompt constraints.

## AI Connection and Local Evidence

Version 0.1.44 checks the configured server's model list instead of treating saved settings as a working connection. **Test connection** verifies generation with fictional data. Provider requests have a five-minute deadline; corrections can be cancelled from the panel and have a ten-minute overall deadline. Incomplete AI output is retried once and rejected if it still cannot be reviewed safely.

Endpoint and model preferences survive service-worker restarts. Remote API keys are bound to their destination, held in session storage, and cleared when the provider or endpoint changes. Keys saved by older releases must be entered again because they have no destination binding.

Local Ollama requests use an extension-scoped Chrome session rule to remove the `Origin` request header on loopback HTTP and the currently configured HTTP server origin. This avoids Ollama's browser-origin rejection without changing environment variables, restarting Ollama, installing a proxy, or modifying requests from Moodle or other websites. Remote HTTPS requests retain their normal headers.

PDF, DOCX, and ODT text is extracted locally using bundled PDF.js and fflate code. Scanned PDF pages, DOCX/ODT images, and PNG/JPEG/WebP attachments are sent as images to the selected provider. Ollama image requests require a model advertising vision support; compatible remote APIs must support image input. Unsupported formats are omitted and marked red in the file preview. Unreadable or oversized files in supported formats still stop correction with an explicit error. Limits: 4 MB per file, 10 MB total input, 60 PDF pages, 60,000 extracted text characters, and 12 images. Image interpretation is performed by the selected vision model, not a separate OCR service.

Build the bundled dependencies and run the Chromium integration checks:

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run test:locales
```

The browser checks use a temporary profile, fictional submissions, and a loopback test provider. To also verify the existing local Ollama installation with `gemma3:4b`, run `node tests/browser-check.mjs --live`. This sends a fictional connection probe and an arithmetic correction with one rubric criterion, not student work. It does not modify the machine's Ollama configuration.

Run `npm run package` to create `release/moodlia-corrector-0.1.66.zip` with the manifest at the archive root and all local parsing dependencies included.

Version 0.1.46 binds a correction to the Moodle assignment, student, attempt,
and extracted submission before requesting AI and before changing form fields.
Navigating to another student while generation is pending rejects the reply;
extract fresh data before correcting the new student. This local snapshot is
excluded from AI prompts. Invalid manual scores and rubric levels fail before
any field is changed; invalid AI rubric selections require repair rather than
silently selecting the lowest level.

PDF pages containing text together with images or vector graphics retain both
the extracted text and a rendered page image. These pages require a vision
model and count toward the 12-image limit. Statement and online submission text
are preserved beyond the former 12,000-character cutoff; each has an explicit
60,000-character limit that stops correction instead of truncating evidence.
Moodle attachment downloads enforce their byte limits while streaming, even
when the server omits a size header.

See [the 2026-10-19 review](docs/review-2026-10-19.md) for reproduction and validation.

## Assignment Supervision

Version 0.1.47 displays the detected grading method in the panel.
Simple direct grading reads maxima such as **Calificación sobre 10** from the
input label even when Moodle uses a text input without a `max` attribute.
Opening the panel also resizes the page's positioning area so fixed and
absolute Moodle grader regions fit beside the AI interface. Closing restores
the page layout. Responsive widths and TinyMCE feedback are covered by
fictional browser fixtures.

See [the 0.1.47 validation](docs/review-2026-10-19-0.1.47.md) for the layout
and direct-grading checks.

Version 0.1.48 fixes embedded themes where `#page` inherits the body's
positioning, which could collapse the document and grade regions. See the
[live layout diagnosis and regression](docs/review-2026-10-19-0.1.48.md).

Version 0.1.45 identifies the assignment title from the matching Moodle task navigation or activity heading instead of the course's `h1`. Linked assignment descriptions are parsed using a detached-document-safe text reader, with a bounded same-origin request.

The supervision panel lists files linked or embedded in the assignment description separately from submitted work. Each reference includes its filename, type, link description, and read status. Detection alone does not download these reference files. Version 0.1.51 reads their contents when requesting AI correction, labels them as assignment references rather than student work, and preserves those labels for text and images. References use the same origin restrictions and shared processing limits as student submissions. Submission extraction only includes submission file areas, and repeated file links are deduplicated. The browser regression fixture covers Moodle under a subdirectory, an editable ODT worksheet, encoded filenames, malformed links, and duplicate download links.

## License

Copyright (C) 2026 Pablo Gallego.

This project is free software released under the GNU General Public License version 3 or later. See `LICENSE`.

LM Studio is available as an explicit provider with the default address `http://127.0.0.1:1234/v1`, optional session-only API key, model discovery, and compatible image input. **Other local server (OpenAI-compatible)** accepts local llama.cpp, LocalAI, or vLLM endpoints. Start the local server yourself, choose **Load models from server**, and verify it with **Test connection**. Local-server providers support configurable HTTP hosts with a user-granted Chrome host permission; remote API mode requires HTTPS. Local compatible applications must support chat completions and JSON-object output; images require a vision model.

## Named servers, address fields, and model selection

Named choices include Ollama, LM Studio, llama.cpp, LocalAI, vLLM, a generic local compatible server, and a remote compatible API. Defaults use Ollama port 11434, LM Studio 1234, llama.cpp/LocalAI 8080, and vLLM 8000. All addresses and ports are editable. The IP/hostname, port (1–65535), protocol, API path, and full URL stay synchronized. IPv6 literals are supported. Each provider retains its own non-secret address/model profile across reopening the settings page; API keys remain bound to the active session destination.

Model discovery now shows a sorted, searchable, keyboard-operable list. Friendly names are displayed when supplied by the server, with parameter count, quantization, and model size only when those values exist. IDs are deduplicated and preserved exactly when choosing a model. Search supports model IDs and metadata, and distinguishes an empty server list from no search matches. The exact model ID remains manually editable. The grading panel also supports model search and richer option labels.

HTTP servers outside loopback require an optional Chrome permission for that specific hostname. The browser permission applies to the host, across ports; request headers are adjusted only for this extension's requests to the configured server origin. No host service, firewall, environment, or CORS configuration is changed.

## Activation and inline AI settings

Open an HTTPS Moodle assignment grader, then click the extension icon to activate the corrector on that page. Nothing is injected automatically into a new Moodle installation by default. The toolbar popup offers only **Añadir sitio** and **Gestionar sitios**. Add an HTTPS Moodle base URL (or use the prefilled current installation) to remember automatic activation. Open the saved-site list and choose **Quitar** to return an installation to manual activation. Correction, files, teacher criteria, and AI settings are available in the sidebar. This follows MoodlIA Rubrics' manual/remembered-site activation workflow. The saved installation includes its Moodle base path. Existing AI/download network permissions are separate from automatic content-script activation; disabling automatic activation does not revoke those network permissions.

In the grading panel, open **Configuración de IA**. **Simple** shows the provider, searchable model selector, refresh, and a fictional connection test. **Avanzado** includes the full provider/address/port/path, model browser, session key controls, save, test, and cancellation workflow. It reuses the options document inside an extension-origin frame, authorized for the requesting grader tab, so API key fields are isolated from the Moodle document. The mode buttons stay available while scrolling. Page/student navigation returns to Simple and cancels connection tests. The standalone options page remains available for compatibility.

## Localization and store submission

The interface supports English, Spanish, French, German, Portuguese, Italian, Galician, and Catalan, with browser detection and a saved override in Advanced settings. Moodle content, teacher criteria, filenames, and AI feedback remain separate from interface localization. See `marketplace/SUBMISSION.md` for the submission kit, declarations, reviewer instructions, verified URLs, and remaining publisher actions.

## Rebuild publication materials

After installing dependencies, run `npm run check`, `npm run test:browser`, `npm run test:locales`, `node scripts/generate-store-assets.mjs`, `node scripts/generate-store-listings.mjs`, `npm run package`, `node scripts/package-store-kit.mjs`, and `node scripts/generate-submission-page.mjs`. The final command extracts the kit when needed and creates an English copy-and-download page at `release/publicar-moodlia-corrector-0.1.66/index.html`. Generated archives and folders stay local and are not committed.

The store-ready extension policy is hosted at `https://moodlia.com/privacy/corrector.html`; Rubrics uses `https://moodlia.com/privacy/rubrics.html`. Both were checked against the website project's source on 20 October 2026. The website project owns these stable routes across redesigns. Source publication on GitHub is separate from a tagged extension release or Chrome Web Store approval; the prepared 0.1.66 build is not a claim of store publication.
