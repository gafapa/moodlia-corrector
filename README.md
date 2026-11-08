# MoodlIA Corrector

MoodlIA Corrector is a Chrome extension that helps teachers review Moodle assignment submissions and fill editable Moodle grading fields with AI suggestions. The teacher reviews those suggestions and decides whether to save the Moodle form.

[Status](#status) · [Getting started](#getting-started) · [Usage](#usage) · [Development](#development) · [Security and privacy](#security-and-privacy) · [Documentation](#documentation) · [License](#license)

## Status

Implemented Chrome extension. Current source version: `0.2.4`. Prepared submission materials do not imply a tagged release or Chrome Web Store approval. Teachers review and save Moodle grades themselves.

The Moodle entry point is now self-contained, including localization. It also works with old automatic-activation registrations that do not list the translation scripts. Assignment overview pages are ignored before initialization. After updating the extension, reload it in `chrome://extensions` and refresh Moodle to replace scripts already running in open tabs.

## Getting started

Build the extension with `npm ci` and `npm run build`, then load the `extension/` directory through **Load unpacked** at `chrome://extensions`. Open a Moodle assignment grader and click the extension icon.

### Activation and inline AI settings

Open an HTTPS Moodle assignment grader, then click the extension icon to activate the corrector on that page. Nothing is injected automatically into a new Moodle installation by default. The toolbar popup offers only **Añadir sitio** and **Gestionar sitios**. Add an HTTPS Moodle base URL (or use the prefilled current installation) to remember automatic activation. Open the saved-site list and choose **Quitar** to return an installation to manual activation. Correction, files, teacher criteria, and AI settings are available in the sidebar. This follows MoodlIA Rubrics' manual/remembered-site activation workflow. The saved installation includes its Moodle base path. Existing AI/download network permissions are separate from automatic content-script activation; disabling automatic activation does not revoke those network permissions.

In the grading panel, open the AI chip in the header (**Configuración de IA**). **Simple** shows the provider, searchable model selector, refresh, and a fictional connection test. **Avanzado** includes the full provider/address/port/path, model browser, session key controls, save, test, and cancellation workflow. It reuses the options document inside an extension-origin frame, authorized for the requesting grader tab, so API key fields are isolated from the Moodle document. The mode buttons stay available while scrolling. Page/student navigation returns to Simple and cancels connection tests. The standalone options page remains available for compatibility.

## Usage

### Named servers, address fields, and model selection

LM Studio is available as an explicit provider with the default address `http://127.0.0.1:1234/v1`, optional session-only API key, model discovery, and compatible image input. **Other local server (OpenAI-compatible)** accepts local llama.cpp, LocalAI, or vLLM endpoints. Start the local server yourself, choose **Load models from server**, and verify it with **Test connection**. Local-server providers support configurable HTTP hosts with a user-granted Chrome host permission; remote API mode requires HTTPS. Local compatible applications must support chat completions and JSON-object output; images require a vision model.

Named choices include Ollama, LM Studio, llama.cpp, LocalAI, vLLM, a generic local compatible server, and a remote compatible API. Defaults use Ollama port 11434, LM Studio 1234, llama.cpp/LocalAI 8080, and vLLM 8000. All addresses and ports are editable. The IP/hostname, port (1–65535), protocol, API path, and full URL stay synchronized. IPv6 literals are supported. Each provider retains its own non-secret address/model profile across reopening the settings page; API keys remain bound to the active session destination.

Model discovery now shows a sorted, searchable, keyboard-operable list. Friendly names are displayed when supplied by the server, with parameter count, quantization, and model size only when those values exist. IDs are deduplicated and preserved exactly when choosing a model. Search supports model IDs and metadata, and distinguishes an empty server list from no search matches. The exact model ID remains manually editable. The grading panel also supports model search and richer option labels.

HTTP servers outside loopback require an optional Chrome permission for that specific hostname. The browser permission applies to the host, across ports; request headers are adjusted only for this extension's requests to the configured server origin. No host service, firewall, environment, or CORS configuration is changed.

### Assignment supervision

Version 0.2.4 reads OpenDocument files saved from LibreOffice Writer/Web, master
documents and templates, which 0.2.3 skipped as unsupported content.

Version 0.2.3 redesigns the grading panel. The header shows the assignment and
course, the student and attempt, the grading method and a chip with the AI
model in use (green when ready), which opens the AI settings. The main view is
three numbered cards: **Evidence for the AI** (files grouped by role, unsupported
files struck through with the reason, and **Add supporting files**), **Teacher
criteria** (tabs for the course, the assignment and this student; a dot marks a
scope with saved text) and **Result**. While a correction runs, a progress card
shows four stages (read the files, review the evidence, write the grade and
feedback, fill in the Moodle form) with a progress bar. **Correction JSON** and
**Data and diagnostics** moved to the **More options** menu.

Version 0.1.47 displays the detected grading method in the panel.
Simple direct grading reads maxima such as **Calificación sobre 10** from the
input label even when Moodle uses a text input without a `max` attribute.
Opening the panel also resizes the page's positioning area so fixed and
absolute Moodle grader regions fit beside the AI interface. Closing restores
the page layout. Responsive widths and TinyMCE feedback are covered by
fictional browser fixtures.

See [the 0.1.47 validation](docs/review-2026-10-19-0.1.47.md) for the layout
and direct-grading checks.

Version 0.2.1 fills every grading method Moodle shows in the grader: a direct
grade, a rubric (one level and comment per criterion), a marking guide (a score
from 0 to the criterion's maximum and a remark per criterion; Moodle adds the
scores into the grade), and a scale (the AI chooses one of the scale's labels,
and "No grade" is left as it is unless a label is chosen). A guide or rubric
frozen because the grade is locked or overridden in the gradebook is refused
before any field changes. The correction result shows a warning with the
excerpts when the student's work contains text addressed to the AI, and a note
when the student's name was replaced in what was sent.

Version 0.1.48 fixes embedded themes where `#page` inherits the body's
positioning, which could collapse the document and grade regions. See the
[live layout diagnosis and regression](docs/review-2026-10-19-0.1.48.md).

Version 0.1.45 identifies the assignment title from the matching Moodle task navigation or activity heading instead of the course's `h1`. Linked assignment descriptions are parsed using a detached-document-safe text reader, with a bounded same-origin request.

The supervision panel lists files linked or embedded in the assignment description separately from submitted work. Each reference includes its filename, type, link description, and read status. Detection alone does not download these reference files. Version 0.1.51 reads their contents when requesting AI correction, labels them as assignment references rather than student work, and preserves those labels for text and images. References use the same origin restrictions and shared processing limits as student submissions. Submission extraction only includes submission file areas, and repeated file links are deduplicated. The browser regression fixture covers Moodle under a subdirectory, an editable ODT worksheet, encoded filenames, malformed links, and duplicate download links.

### Localization and store submission

The interface supports English, Spanish, French, German, Portuguese, Italian, Galician, and Catalan, with browser detection and a saved override in Advanced settings. Moodle content, teacher criteria, filenames, and AI feedback remain separate from interface localization. See `marketplace/SUBMISSION.md` for the submission kit, declarations, reviewer instructions, verified URLs, and remaining publisher actions.

### Source-code evidence

Source-code evidence is read as literal text (UTF-8, UTF-16 with a byte-order mark, or Windows-1252), never executed or rendered as HTML. Supported extensions include C/C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`), web source (`.html`, `.css`, `.scss`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`), Python, Java/Kotlin, C#, Go, Rust, PHP, Ruby, R, Lua, SQL, shell/PowerShell scripts and common text configuration formats. The same reader supports Moodle submissions, linked assignment references and teacher-added files. Upload source files individually; archives and compiled executables remain unsupported.

## Development

### Structure

- `extension/`: loadable extension, including the generated content entry point.
- `src/content/moodleContent.js`: editable grading-panel source; `scripts/build-content.mjs` bundles it with the local runtime modules. The panel observes the grader page only while it is open, and reuses the assignment description page for every student of the same assignment.
- `extension/lib/`: generated by `scripts/build-attachments.mjs` from `node_modules`: the minified PDF.js legacy build, fflate, PDF.js fonts and CMaps, and only the WebAssembly decoders PDF.js loads (JBIG2, OpenJPEG, QCMS). `scripts/extension-assets.mjs` holds the list and the packaging check.
- `marketplace/`: localized store listings, screenshots, privacy statements, and submission instructions.
- `scripts/`: reproducible localization, packaging, and publication-page generators.
- `release/`: generated archives and extracted publication materials; ignored by Git.

### Quality checks

```bash
npm run check
```

The suite validates manifest assets, Moodle grader-page and attachment-origin restrictions, direct AI transport and configuration sanitization, correction parsing, rubric normalization, fallback behavior, privacy minimization, and prompt constraints.

### AI connection and local evidence

Version 0.1.44 checks the configured server's model list instead of treating saved settings as a working connection. **Test connection** verifies generation with fictional data. Provider requests have a 15-minute deadline; corrections can be cancelled from the panel and have a 60-minute overall deadline. Moodle downloads have two minutes per file and local document reading three minutes per file. While correcting, the panel shows the step in progress (downloads, reading each file, each evidence block, writing the correction) and the elapsed seconds. **Correct when moving to the next student** starts the next student's correction once their data is read; a student already corrected on the page is not corrected again, and the teacher still reviews and saves each grade. Incomplete AI output is retried once and rejected if it still cannot be reviewed safely.

Endpoint and model preferences survive service-worker restarts. Remote API keys are bound to their destination, held in session storage, and cleared when the provider or endpoint changes. Keys saved by older releases must be entered again because they have no destination binding.

Local Ollama requests use an extension-scoped Chrome session rule to remove the `Origin` request header on loopback HTTP and the currently configured HTTP server origin. This avoids Ollama's browser-origin rejection without changing environment variables, restarting Ollama, installing a proxy, or modifying requests from Moodle or other websites. Remote HTTPS requests retain their normal headers.

PDF, DOCX, ODT, XLSX, ODS, PPTX and ODP text is extracted locally using bundled PDF.js and fflate code. All PDF pages are rendered locally and sent as page images beside their text. Office document pages (DOCX and ODT, spreadsheets XLSX and ODS printed sheet by sheet, presentations PPTX and ODP one page per slide) are laid out locally from the file's own styles; by default only pages that show images, formulas, tables, drawings, borders or shading are sent as images, and pages with only text are sent as text (Options → **Page images of Office documents** → **Every page** sends all of them; see [`docs/office-page-rendering.md`](docs/office-page-rendering.md)). Text drawn so that a reader cannot see it (white on white, tiny, off the page) is left out and reported in the receipt; list and heading numbers are part of the extracted text. Before anything is sent, the student's name as Moodle shows it is replaced with `[Student]` in the text and covered on page images (Options → **Student name** turns this off), and visible text in the work that addresses the AI ("ignore the rubric", "ponme un 10") is shown to the teacher as a warning. With Ollama, a correction whose largest request needs more context than the model is loaded with asks for a larger `num_ctx` for that correction only. Correcting the same file again reuses the pages already drawn for 30 minutes; the offscreen reader is closed once nothing is cached or being read for two minutes; PNG/JPEG/WebP attachments are also sent as images to the selected provider. Ollama image requests require a model advertising vision support; compatible remote APIs must support image input. With an Ollama model that reports no image input, Office documents are still read as text without their page images (the receipt says so); PDF pages and image files still need a vision model. Unsupported formats are omitted and marked red in the file preview. Unreadable or oversized files in supported formats still stop correction with an explicit error. Limits: 20 MB per file, 40 MB total input, 60 pages per PDF or Office document (60 visible slides per presentation, 10,000 non-empty cells per spreadsheet), 600,000 extracted attachment text characters, and 120 images (each rendered page, or each part of a page drawn in parts, counts as one image). Large attachment sets are reviewed in blocks of at most 24,000 characters, four images and 32 MB of image data, with each page's text kept in the same block as its image, with derived notes combined before the final correction. Generation uses streaming where supported and a cancellable 15-minute deadline per request. Image interpretation is performed by the selected vision model, not a separate OCR service.

Build the bundled dependencies and run the Chromium integration checks:

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run test:locales
```

The browser checks use a temporary profile, fictional submissions, and a loopback test provider. `npm run test:fidelity` compares our DOCX and ODT pages with LibreOffice PDFs over a fictional corpus ([`docs/rendering-fidelity.md`](docs/rendering-fidelity.md)). `node tests/live-pdf-check.mjs` and `node tests/live-office-check.mjs` are opt-in checks against an installed local Ollama model (`gemma4:e4b` by default) with fictional documents. `tests/moodle-lab-check.mjs` runs the extension against a real disposable Moodle site; the **Moodle lab** GitHub Actions workflow (`.github/workflows/moodle-lab.yml`, manual or weekly) runs it on Moodle 4.5 to 5.3 with the public lab images. To also verify the existing local Ollama installation with `gemma3:4b`, run `node tests/browser-check.mjs --live`. This sends a fictional connection probe and an arithmetic correction with one rubric criterion, not student work. It does not modify the machine's Ollama configuration.

Run `npm run package` to create `release/moodlia-corrector-0.2.4.zip` with the manifest at the archive root and all local parsing dependencies included.

Version 0.1.46 binds a correction to the Moodle assignment, student, attempt,
and extracted submission before requesting AI and before changing form fields.
Navigating to another student while generation is pending rejects the reply;
extract fresh data before correcting the new student. This local snapshot is
excluded from AI prompts. Invalid manual scores and rubric levels fail before
any field is changed; invalid AI rubric selections require repair rather than
silently selecting the lowest level.

PDF pages containing text together with images or vector graphics retain both
the extracted text and a rendered page image. These pages require a vision
model and count toward the 120-image limit. Statement and online submission text
are preserved beyond the former 12,000-character cutoff; each has an explicit
60,000-character limit that stops correction instead of truncating evidence.
Moodle attachment downloads enforce their byte limits while streaming, even
when the server omits a size header.

Version 0.1.74 reads the complete online text that Moodle's grader hides behind
its 140-character summary, and asks Ollama with `truncate: false` to fail
instead of silently cutting a request that exceeds the allocated context. It
keeps DOCX/ODT text when an embedded image format is unsupported and reports
those images in the evidence receipt. See
[`docs/ollama-request-pipeline.md`](docs/ollama-request-pipeline.md) and
[`docs/ollama-request-fixes-2026-10-27.md`](docs/ollama-request-fixes-2026-10-27.md).

Version 0.1.77 stores per-student ("case") criteria under the real Moodle user
and attempt; the grader's hidden `userid` input is `0` for every student, so
earlier versions shared one set of case criteria. It also keeps scanned PDFs
within Chrome's message limit (JPEG pages), ignores plagiarism and portfolio
links in file rows, refuses frozen rubrics, writes editor feedback as escaped
HTML, and identifies document formats from their bytes. See
[`docs/review-2026-10-27-0.1.77.md`](docs/review-2026-10-27-0.1.77.md).

Version 0.2.1 raises the attachment limits to 20 MB per file and 40 MB in
total, the most that manually added files can carry in one Chrome message. It
also renders DOCX and ODT files as pages, like PDFs: tables, lists, equations,
images, footnotes, headers and footers are visible to the model on each page
image. See [`docs/office-page-rendering.md`](docs/office-page-rendering.md). Its review
([`docs/review-2026-10-28-0.2.1.md`](docs/review-2026-10-28-0.2.1.md)) bounds
repeated ODT table cells, leaves hidden text out of what is sent, reports a
grade field that Moodle does not show instead of "applied", and keeps each
page's text in the same review block as its image. Later improvements
([`docs/improvements-2026-10-28-0.2.1.md`](docs/improvements-2026-10-28-0.2.1.md))
leave out text drawn invisibly, add list numbers to the text, continue Word
numbering across lists that share a definition, send text-only DOCX and ODT
pages as text by default, draw very tall pages in parts, reuse drawn pages,
show correction progress, add automatic correction of the next student, and fix
the panel's 30-minute cut-off.

Version 0.2.1 also reads spreadsheets (XLSX, ODS) and presentations (PPTX,
ODP) locally. Each visible sheet is printed on landscape pages with gridlines,
column letters and row numbers, and its text lists every non-empty cell with
its reference and formula (`B3: 15 (=SUM(B1:B2))`) and cell comments. Each
visible slide becomes one page at the slide size, with placeholders inherited
from the layout and master, pictures, shapes and tables; its text follows the
reading order and adds the speaker notes. Hidden sheets, rows, columns and
slides are left out and counted. Legacy XLS and PPT files remain unsupported.
See [`docs/office-page-rendering.md`](docs/office-page-rendering.md#spreadsheets-xlsx-and-ods).

See [the 2026-10-19 review](docs/review-2026-10-19.md) for reproduction and validation.

### Rebuild publication materials

After installing dependencies, run `npm run check`, `npm run test:browser`, `npm run test:locales`, `node scripts/generate-store-assets.mjs`, `node scripts/generate-store-listings.mjs`, `npm run package`, `node scripts/package-store-kit.mjs`, and `node scripts/generate-submission-page.mjs`. The final command extracts the kit when needed and creates an English copy-and-download page at `release/publicar-moodlia-corrector-0.2.4/index.html`. Generated archives and folders are not committed. Run `node scripts/validate-store-materials.mjs --artifacts` to verify the current kit and copy page, including all eight corrected descriptions.

The store-ready extension policy is hosted at `https://moodlia.com/privacy/corrector.html`; Rubrics uses `https://moodlia.com/privacy/rubrics.html`. Both public policies were checked against the website project's source on 24 October 2026. The published policy retains its original effective date; its "Version covered" line names the current build. The website project owns these stable routes across redesigns. Source publication on GitHub is separate from a tagged extension release or Chrome Web Store approval; a prepared build is not a claim of store publication.

## Security and privacy

The extension connects directly to Ollama running on the teacher's computer or to LM Studio, llama.cpp, LocalAI, vLLM, another compatible local server, or an OpenAI-compatible API selected by the institution. It does not require AI Runtime or any other browser extension.

Remote AI endpoints must use HTTPS, and provider requests do not follow redirects. Local-server modes may use HTTP on loopback or an explicitly permitted network host. HTTP on a LAN is unencrypted; use HTTPS for sensitive network traffic. API keys remain in Chrome session storage. Prompts omit the structured student-name, course-name and Moodle-page-URL fields and submitted filenames (a filename is included only when the teacher's criteria mention it, to identify that file; DOCX file-name fields are not drawn or sent); text and documents may still contain identifying information, so this is not guaranteed anonymization. The assignment evidence and rubric still reach the selected provider and must be handled under the institution's privacy policy.

## Documentation

- [Project Pages](https://gafapa.github.io/moodlia-corrector/)

Build the repository documentation portal with `python tools/build-project-page.py`. Its status comes from this README; purpose and first steps are maintained in `docs/project-page.json`. The `pages.yml` workflow publishes the portal without deploying the application or changing `moodlia.com`.

AI-assisted review of assignment submissions; [Rubrics](https://github.com/gafapa/moodlia-rubrics) imports assessment forms from spreadsheets.

- [Source code](https://github.com/gafapa/moodlia-corrector)
- [Issue tracker](https://github.com/gafapa/moodlia-corrector/issues)
- [MoodlIA website](https://moodlia.com)
- [extension/README.md](extension/README.md)
- [marketplace/SUBMISSION.md](marketplace/SUBMISSION.md)
- [CHANGELOG.md](CHANGELOG.md)
- [docs/review-2026-10-24-0.1.71.md](docs/review-2026-10-24-0.1.71.md)
- [docs/office-page-rendering.md](docs/office-page-rendering.md)
- [docs/review-2026-11-08-0.2.4.md](docs/review-2026-11-08-0.2.4.md)
- [docs/review-2026-11-07-0.2.3.md](docs/review-2026-11-07-0.2.3.md)
- [docs/review-2026-11-07-0.2.2.md](docs/review-2026-11-07-0.2.2.md)
- [docs/review-2026-10-28-0.2.1.md](docs/review-2026-10-28-0.2.1.md)
- [docs/review-2026-10-27-0.1.77.md](docs/review-2026-10-27-0.1.77.md)
- [docs/review-2026-10-27-0.1.76.md](docs/review-2026-10-27-0.1.76.md)
- [docs/review-2026-10-21-0.1.67.md](docs/review-2026-10-21-0.1.67.md)

## License

Copyright (C) 2026 Pablo Gallego.

This project is free software released under the GNU General Public License version 3 or later. See `LICENSE`.
