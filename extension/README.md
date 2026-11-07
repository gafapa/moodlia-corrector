# MoodlIA Corrector

Chrome extension that extracts Moodle grading context, sends it directly to the AI provider selected by the teacher or institution, and applies the teacher-reviewed result back into the Moodle grading form.

## Status

Implemented extension source, version `0.2.2`. The build is a prepared candidate; store submission and approval are separate. The extension fills editable Moodle fields and never saves the grading form.

## Getting started

### Load in Chrome

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Click **Load unpacked**.
4. Select the `extension` folder from this project.
5. Open an HTTPS Moodle assignment grader and click the extension icon to activate it on that page.
6. In the correction panel, open **Configuración de IA**. Use **Simple** for provider/model selection, or **Avanzado** for the full endpoint, port, model, and session-key settings.
7. Optionally choose **Añadir sitio** in the popup and save the HTTPS Moodle base URL to activate automatically on future grader pages. Use **Gestionar sitios** and **Quitar** to remove saved activation.

The API key is retained only in Chrome session storage. Provider, endpoint, and model are saved as non-secret preferences.

Remote providers must use HTTPS, and AI requests reject redirects. Initial Moodle file URLs must use the HTTPS origin of the active grading page. Downloads may follow up to five HTTPS redirects to signed external storage; cookies are omitted outside the original Moodle origin. Redirect loops, credentials in URLs, and HTTP downgrades are rejected. AI prompts omit the student's name, course name, Moodle URLs, and original filenames (except a filename the teacher's criteria mention); assignment evidence, rubric content, and readable submitted content are still sent to the provider selected by the teacher.

Use **Test connection** to verify generation with fictional data. The panel checks the server and installed models; a saved configuration alone is not reported as ready. **Cancel** aborts a running correction. While correcting, the status line shows the current step and the elapsed seconds. **Correct when moving to the next student** starts the next student's correction automatically once their data is read (never twice for the same student on the page); nothing is saved without the teacher. Local Ollama access is handled inside the extension without changing the computer's environment or CORS configuration.

**Supervision** includes the detected task title and a separate list of files from the task description, with filename, format, and link description. These reference links are detected without downloading them. From version 0.1.51, requesting AI correction reads their content and labels it as assignment reference material, separately from student work.

PDF/DOCX/ODT/XLSX/ODS/PPTX/ODP extraction runs locally. PDF pages are sent as page images beside each page's text. Office document pages (DOCX, ODT, spreadsheet sheets and presentation slides) are sent as images when they show images, formulas, tables, drawings, borders or shading, and as text when they show only text (Options → **Page images of Office documents** → **Every page** sends all pages as images), so images and such pages require a vision-capable model. DOCX and ODT text drawn so that a reader cannot see it, or covered by a picture, is left out (`invisible-text-excluded`), and list numbers are included in the text. The student's name is replaced with `[Student]` before sending and covered on page images (Options → **Student name**); text in the work addressed to the AI is shown as a warning. With an Ollama model that reports no image input, Office documents are sent as text only and the receipt reports `page-images-not-sent`. Unsupported formats are omitted and marked red, with an explicit reason, in the panel. Unreadable or oversized evidence in a supported format still stops correction with an explicit error. See the project README for processing limits and browser verification commands.

Version 0.1.46 also renders PDF pages containing text and graphics for vision
review. Corrections are bound to the extracted student and submission; changes
while the model is running require fresh extraction. Invalid scores or rubric
levels are rejected before form edits. Statement and online text are preserved
up to 60,000 characters each; larger inline inputs stop correction explicitly.
Attachments support up to 600,000 extracted characters and 120 images in total,
with 20 MB per-file, 40 MB total input and 60-page PDF/DOCX/ODT safeguards retained.
Large attachment sets are reviewed sequentially in blocks of at most 24,000
characters and four images. Every fragment retains its source number and role.
Evidence notes are combined, recursively when necessary, before the final
correction and schema validation. This derived review can lose detail; teachers
must review the suggestion against the original work. An invalid or oversized
block review is condensed once with a text-only request; if it is still
invalid, the correction stops without applying grades.

Moodle's grader shows online text as a 140-character summary and keeps the
complete text in a hidden box. From 0.1.74 the extension reads that complete
box whether or not the teacher expanded it.
From 0.2.1 DOCX and ODT files are laid out from their own styles and rendered
page by page, like a PDF. Headings, tables (with repeated header rows and Word
table styles), numbered lists, equations, images, footnotes, headers and footers
appear on each page image, and the text is split by page. Pages follow the page
breaks Word or Writer saved, when present. Images in EMF, WMF or TIFF, charts,
SmartArt and linked images are marked on the page and counted in
`omittedImages`. If rendering fails, the file keeps its text and embedded images
(GIF and BMP converted to PNG) and the receipt reports `page-rendering-failed`.
See [`../docs/office-page-rendering.md`](../docs/office-page-rendering.md).
From 0.2.1 spreadsheets (XLSX, ODS) and presentations (PPTX, ODP) are read the
same way. Sheets are printed on landscape A4 pages with gridlines, column
letters repeated on every page and row numbers; columns that do not fit
continue on the following pages. Their text lists each non-empty cell as
`A1: value`, with formulas in parentheses after the saved result, and cell
comments as `[Comment A1: ...]`. Slides become one page each at the slide
size; placeholders take their position and style from the layout and master.
Their text starts with `[Slide N]`, follows the reading order and ends with
`[Speaker notes]`. Hidden sheets, rows, columns and slides are left out and
counted as `hidden-text-excluded`; charts, SmartArt and media are marked on the
page and counted in `omittedImages`. Limits: 10,000 non-empty cells per
spreadsheet, 60 visible slides per presentation.
Version 0.1.75 preserves ODT CDATA, checks the remaining text budget before
expanding repeated spaces, and rejects invalid repetition counts. Cancelling
DOCX or ODT extraction stops after the current image decode settles, releases
its bitmap and canvas, and prevents subsequent image conversions.
AI generation uses Ollama NDJSON or compatible SSE streaming, with a cancellable
15-minute deadline per request. Truncated streams are rejected. Provider or
proxy timeouts can still occur independently of this extension deadline.

### Manual and remembered-site activation

Activation follows MoodlIA Rubrics: clicking the icon activates the current grader, while **Añadir sitio** saves installation-specific automatic activation. The popup contains only **Añadir sitio** and **Gestionar sitios**; all correction and AI controls live in the sidebar. Dynamic content scripts persist across browser restarts and are registered only for remembered Moodle assignment paths. **Gestionar sitios** lists saved Moodle installations, and **Quitar** unregisters the selected installation; the already-open corrector remains available until navigation/reload, and future pages require a click again. Repeated activation does not create duplicate panels/listeners. The popup also supports adding and managing saved sites outside grader pages.

This is an activation policy, separate from the network permissions needed for selected AI services, authenticated Moodle file downloads, and signed storage redirects. Those existing network permissions are retained; automatic activation is not enabled on every HTTPS site.

## Usage

### Current flow

Version 0.1.77 keys **Case** criteria by the real Moodle user and attempt. In
the grader, Moodle's hidden `userid` input is `0` for every student, so earlier
versions stored one shared set of case criteria for all students. Case criteria
written before 0.1.77 stay under that shared key and are not shown or migrated.
Attempt `-1` (latest) resolves to the real attempt number.

Version 0.1.77 also:

- reads only Moodle submission file-area links as submitted files, excluding
  plagiarism reports and portfolio buttons in the same row;
- refuses to apply a frozen rubric (grade locked or overridden in the gradebook);
- writes editor feedback as escaped HTML paragraphs into the textarea and TinyMCE;
- shows grading-guide and scale modes as filled manually, because only the
  overall feedback is written there (version 0.2.1 fills them: see below);
- lets the Moodle panel switch only between saved AI servers and models, while
  new addresses and keys are entered in Options.

Version 0.1.56 copies the last used course and assignment criteria into a new
context when that context has no saved value. Copying stays within the Moodle
installation. Existing criteria, including explicitly cleared text, take
precedence; concrete-case criteria are never used as defaults. The compact
file preview lists names with one purpose description per group. Grading mode
and detection status now appear prominently below the tool icons.

Version 0.1.55 replaces the single instruction field with three saved teacher
criteria: **Course** applies across tasks in that course, **Assignment** applies
to all students in that task, and **Case** applies only to the detected student
and attempt. The panel saves and restores each matching scope. Moodle sites
and installations remain isolated; missing course/student identities disable
the affected field instead of applying a broader fallback.

AI requests carry the three criteria separately and repeat their exact text as explicit system guidance, including during schema repair. Teacher language, length, and formatting preferences override generic feedback defaults. Explicit teacher-declared assumptions (for example, treating a missing ZIP as submitted) apply to that requirement without an absence penalty or re-upload request; they do not authorize inventing file contents or assuming other deliverables were submitted. Actual instruction compliance still depends on the selected model and requires teacher review. Task and case refinements
take precedence over broader guidance where compatible with the Moodle rubric
and available evidence. Older global instructions remain stored and can be
copied to the current assignment with the recovery button; they are not
automatically assigned to a course or student.

Teacher criteria take precedence over the entire assignment statement, linked descriptions,
and reference attachments in every assessment matter: objectives, topics, content,
activities, deliverables, formats, filenames, length, deadlines, penalties, and exceptions.
Priority between teacher scopes is Case, then Assignment, then Course. Requirements
not overridden remain applicable. Overrides apply consistently to grading, rubric
interpretation, and all feedback, including block review and schema repair; a superseded
requirement must not return as a penalty or resubmission request. Moodle's technical
scale, criterion identities, allowed levels, and output schema remain unchanged, and
the model must not invent inspected evidence.

Teacher criteria can, for example, replace the PDF or topic requested in the assignment.
For example: "Use Alternative.pdf instead of Original.pdf; do not penalize this substitution."
The alternative must be available as a submission or an additional file. Names explicitly
mentioned in the criteria are mapped to attachment numbers, including during block review
and schema repair; unrelated filenames and file URLs remain omitted. This does not
download new URLs from criteria or turn reference material into student-authored work.
Unavailable contents must still be reported, and model compliance requires teacher review.

Version 0.1.54 simplifies the side panel. The main view shows file purposes,
saved instructions, and readable proposed grades/feedback. Three SVG icon
buttons open **AI configuration**, **Correction JSON**, and **Data and
diagnostics**. Buttons have accessible labels and native tooltips. Press Escape
or use **Return to correction** to go back; Escape restores focus to the icon.
The JSON editor and all diagnostic controls remain available in those views.

Version 0.1.52 adds **Archivos que se incluirán y para qué** to the panel. It lists each planned filename and its role: assignment explanation or
template, student work to assess, or additional material supplied by the teacher.
It updates when manual files change and when the new page is detected. The
preview also identifies online text and explains that unreadable files stop
correction. Displaying filenames locally does not add them to provider prompts.

Version 0.1.49 resets the assistant when navigating to another page or student,
including asynchronous Moodle navigation. Pending AI work is cancelled and
per-page suggestions, JSON, and additional files are cleared.
An open panel detects the new context automatically. AI preferences and Moodle
form fields are preserved. Returning to a previous URL does not revive a stale
correction.

Version 0.1.50 saves additional correction instructions automatically in local
extension storage. The panel restores saved text, including
after navigation or reopening the browser. Page resets preserve instructions;
clearing the field also updates the saved value. AI settings and instructions
are persistent preferences; generated corrections and uploaded files remain
specific to the current page.

1. Open any HTTPS Moodle assignment grading page (`/mod/assign/view.php?action=grader`), including sites installed below a subdirectory.
2. Open the assistant panel and review the detected Moodle data.
3. Optional: open the JSON icon, paste an external correction, and click **Apply JSON to Moodle**.
4. Configure AI through its icon if needed, return to the main view, and click **Correct with AI**.
5. Review the filled Moodle fields before saving.

The extension never submits the Moodle grading form. The teacher remains responsible for reviewing and saving the final grade.

### External correction JSON

The JSON tool accepts one object with this shape:

```json
{
  "finalComment": "Final feedback for the Moodle feedback comments box.",
  "score": null,
  "maxScore": null,
  "rubricSelections": [
    {
      "criterionNumber": 1,
      "levelIndex": 3,
      "criterionFeedback": "Feedback for this rubric criterion."
    }
  ]
}
```

Rules:

- `finalComment` is copied to the final Moodle feedback box when it exists. The old aliases `studentFeedback`, `finalFeedback`, and `feedback` also work.
- `score` is only applied when Moodle exposes a numeric grade field; use `null` otherwise.
- `rubricSelections` should include one item per Moodle rubric criterion.
- `criterionNumber` is one-based and follows the visible Moodle rubric order: `1`, `2`, `3`, and so on.
- If you prefer zero-based indexing, use `criterionIndex` instead of `criterionNumber`.
- Each item must identify its criterion explicitly, using `criterionId`, `criterionNumber`, or `criterionIndex`. Array position and fuzzy description matching are never used as criterion identities. AI-generated corrections must use exact `criterionId` values.
- `levelIndex` is zero-based: the first visible level is `0`, the next is `1`, and so on.
- `criterionFeedback` is copied to the criterion comment textarea.
- With a Moodle marking guide, add `guideScores`: one `{ "criterionId", "score", "remark" }` item per guide criterion (`criterionNumber` or `criterionIndex` also identify it). `score` goes from 0 to the criterion's maximum and is written with a dot decimal separator; `remark` goes to the criterion's remark box. Every criterion needs a valid score and a remark, or nothing is applied. Moodle adds the scores into the grade, so `score` stays `null`.
- With a scale grade (a select), add `scaleGrade` with one of the scale's visible labels (case and spaces are ignored). An unknown label is refused before any field changes; without `scaleGrade` the select, including "No grade", is left as it is.

### Marking guides, scales and evidence warnings (0.2.1)

The panel fills a Moodle marking guide (`gradingform_guide`, the same renderer
in Moodle 4.5, 5.0, 5.1, 5.2 and the main branch): each criterion's `advancedgrading[criteria][<id>][score]`
input and `[remark]` textarea. The AI receives each criterion's short name,
description for students and markers, and maximum, and the Ollama schema bounds
each score; Moodle sums the scores into the grade, so no grade input is written.
A guide rendered `evaluate frozen` (grade locked or overridden in the gradebook),
`review` or `view` is refused like a frozen rubric. For a scale grade the AI
chooses one of the select's labels (the schema lists them as an enum); "No grade"
(`-1`) is never offered. Before the first AI request the panel shows the plan
(pages, images, estimated tokens and blocks). The result lists, as a warning,
excerpts of student text addressed to the AI, and notes how many times the
student's name was replaced in what was sent.

For the PLATEGA example shown in the prompt, the recommended JSON uses numbers instead of Moodle ids:

```json
{
  "finalComment": "Good overall work. Review the marked criteria to improve the justification and final analysis.",
  "score": null,
  "maxScore": null,
  "rubricSelections": [
    { "criterionNumber": 1, "levelIndex": 3, "criterionFeedback": "The activity is clearly described." },
    { "criterionNumber": 2, "levelIndex": 2, "criterionFeedback": "Curricular elements are present, but their relationship could be more explicit." },
    { "criterionNumber": 3, "levelIndex": 3, "criterionFeedback": "The assessment instrument is appropriate and justified." },
    { "criterionNumber": 4, "levelIndex": 2, "criterionFeedback": "The AI tool and its functionality are identified." },
    { "criterionNumber": 5, "levelIndex": 3, "criterionFeedback": "The use of AI is described and includes evidence." },
    { "criterionNumber": 6, "levelIndex": 3, "criterionFeedback": "The adaptations are explained, although the justification can be improved." },
    { "criterionNumber": 7, "levelIndex": 3, "criterionFeedback": "The conclusions are clear, but the benefits and difficulties need deeper analysis." }
  ]
}
```

### LM Studio and other local compatible servers

Select **LM Studio on this computer** in AI settings. Its default address is `http://127.0.0.1:1234/v1`. Start the server in LM Studio, load an instruction/chat model, click **Load models from server**, select a discovered model, and use **Test connection**. The extension uses the OpenAI-compatible models and chat-completions endpoints. It does not start, install, or configure the local application.

Local authentication is optional. If the server requires a token, enter it in the API key field; it remains bound to the configured provider/destination and stored only in the Chrome session. Images use compatible multimodal content parts and require a vision-capable model/server. JSON correction generation requires JSON-object response support.

**Other local server (OpenAI-compatible)** defaults to `http://127.0.0.1:8080/v1`; change it to the actual endpoint of llama.cpp, LocalAI, or vLLM. These applications are compatible API candidates, not individually runtime-qualified by this extension's synthetic tests. For HTTP on another machine, Chrome requests optional access to the chosen host when saving, listing models, or testing. Use HTTPS outside a trusted network. Remote API mode always requires HTTPS. An extension-scoped Origin rule applies to loopback and the currently configured HTTP server origin; no host CORS configuration is changed.

References: [LM Studio compatibility endpoints](https://lmstudio.ai/docs/developer/openai-compat), [LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [LocalAI](https://localai.io/docs/faq/), and [vLLM compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/).

### Named servers, address fields, and model selection

Named choices include Ollama, LM Studio, llama.cpp, LocalAI, vLLM, a generic local compatible server, and a remote compatible API. Defaults use Ollama port 11434, LM Studio 1234, llama.cpp/LocalAI 8080, and vLLM 8000. All addresses and ports are editable. The IP/hostname, port (1–65535), protocol, API path, and full URL stay synchronized. IPv6 literals are supported. Each provider retains its own non-secret address/model profile across reopening the settings page; API keys remain bound to the active session destination.

Model discovery now shows a sorted, searchable, keyboard-operable list. Friendly names are displayed when supplied by the server, with parameter count, quantization, and model size only when those values exist. IDs are deduplicated and preserved exactly when choosing a model. Search supports model IDs and metadata, and distinguishes an empty server list from no search matches. The exact model ID remains manually editable. The grading panel also supports model search and richer option labels.

HTTP servers outside loopback require an optional Chrome permission for that specific hostname. The browser permission applies to the host, across ports; request headers are adjusted only for this extension's requests to the configured server origin. No host service, firewall, environment, or CORS configuration is changed.

### Interface languages

The interface supports English, Spanish, French, German, Portuguese (Brazilian catalog, also used for other Portuguese browser variants), Italian, Galician, and Catalan. It follows the browser language with English fallback. Select **Interface language** in Advanced settings to override it, then reload open Moodle pages. The setting affects extension controls only; teacher criteria, Moodle content, filenames, and generated feedback are not translated. Feedback continues to follow the Moodle page language or explicit teacher instructions. Low-level provider diagnostics are preserved when no catalog entry exists.

Catalog sources are in `scripts/localization/messages.txt`. `npm run build` generates native Chrome `_locales` files and the bundled runtime catalog. No translation service or network request is used. Run `npm run test:locales` to exercise all eight locales and regenerate fictional demonstration screenshots.

Version 0.1.66 preserves the initialized language runtime across repeated manual activation. A saved interface language remains active even when it differs from the browser language.

### Simple/advanced settings inside the correction panel

The settings tool now has two modes. Simple selects any supported provider and a model, filters models, refreshes availability, and starts/cancels a fictional connection test. Provider changes restore that provider's saved endpoint/model profile. Advanced embeds the same settings document used by the options page, including all address fields, model browser, API-key deletion, save, generation test, and cancellation.

The advanced form uses an extension-origin frame. A short-lived token is issued only to a grader tab and checked against that tab and the extension document before the form initializes. Only sizing information crosses the frame boundary; API keys do not pass through page messages or Moodle DOM fields. The parent verifies the frame origin, window, and token for sizing. Leaving the grader or changing students removes the frame, returns to Simple, and cancels pending connection tests. Simple controls refresh when a saved configuration changes; delayed status results cannot replace a newer status request.

### Source-code evidence

Source-code evidence is read as literal text (UTF-8, UTF-16 with a byte-order mark, or Windows-1252), never executed or rendered as HTML. Supported extensions include C/C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`), web source (`.html`, `.css`, `.scss`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`), Python, Java/Kotlin, C#, Go, Rust, PHP, Ruby, R, Lua, SQL, shell/PowerShell scripts and common text configuration formats. The same reader supports Moodle submissions, linked assignment references and teacher-added files. Upload source files individually; archives and compiled executables remain unsupported.

## Development

Build and validation commands run from the repository root: `npm ci`, `npm run check`, `npm run test:browser`, and `npm run test:locales`.

See [the Moodle-to-Ollama pipeline](../docs/ollama-request-pipeline.md) for the
source fields, privacy boundary, local extraction, evidence phases, native JSON
schema, streaming behavior and a shortened request example. Native Ollama uses
the final correction schema; evidence reviews request observations only.

### Versioning

Version 0.1.48 also preserves body positioning to avoid collapsing embedded
grader pages whose theme makes `#page` inherit that positioning. The document,
grade region, and bottom actions keep the available viewport height.

Version 0.1.47 identifies simple direct grading, including Moodle text inputs
whose maximum is only present in the associated label. The side panel displays the detected method and direct-grade maximum. Rubric and guide
forms retain priority over an accompanying numeric grade field.

Opening the AI panel reserves space on its left for the Moodle page, including
positioned grader regions, navigation, and action bars. The reserved width
tracks the panel on resize; closing it restores the original layout. Wide
content remains scrollable within the available page area.

Increase `manifest.json` version with every extension change.

## Security and privacy

### Audit hardening in 0.1.58

Correction validation is shared by the background worker and grading panel. A `needsRepair: true` result remains blocked when copied into the manual JSON editor. Invalid JSON or invalid rubric selections are reported in the panel before changing form values. Attachment bodies are serialized inside JSON string fields, separately from trusted role metadata and image positions. Models may still misinterpret adversarial evidence; teachers must review every suggestion.

Navigation monitoring observes grader DOM changes and browser navigation events. A one-second fallback reads only URL, hidden user/attempt properties, and the course class. Monitoring stops outside the grader and resumes on return.

Use **Remove saved API key** in AI settings to erase the current session key. An empty password field during a normal save preserves an existing key for the same normalized destination.

The `webRequest` permission reads redirect response headers only while an extension-initiated attachment download is pending. It does not modify website requests or forward Moodle cookies to external storage. See the [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest) for response-header event semantics. Broad HTTPS host access is still needed for arbitrary Moodle sites, selected remote AI endpoints, and signed storage destinations; HTTP network servers use optional host-specific grants. Content scripts run only on assignment-view URL patterns.

Packaging compares every required PDF.js/fflate library file, worker, font, CMap, WASM binary, and license with the installed dependencies. Missing, changed, or empty bundled assets fail packaging. Extension text files must be valid UTF-8.

## Documentation

See the [project README](../README.md), [changelog](../CHANGELOG.md), and [store submission guide](../marketplace/SUBMISSION.md). Historical version notes below describe when individual behaviors were introduced.

## License

GPL-3.0-or-later. See [LICENSE](../LICENSE).

Version 0.1.71 bundles its own localization and grading dependencies at the stable content-script path, so older saved registrations cannot omit them. Overview pages are ignored. Edit the grader in `../src/content/moodleContent.js` from this directory and rebuild from the repository root; packaging rejects an outdated entry point. Reload the extension and Moodle after updating.


### Long-operation messaging

Correction and connection tests use a dedicated runtime port. The requesting
page sends a heartbeat every 20 seconds to keep an active MV3 worker reachable.
Closing or navigating away from the requesting page disconnects the port and
cancels its operation. If Chrome restarts the worker, the client reports the
disconnection and requires a fresh request; it never automatically repeats an
AI correction. The overall operation deadline is 60 minutes, with a 15-minute
limit on each provider request. Reload the extension and existing Moodle tabs
after updating so callers and the worker use the same protocol.


### PDF visual evidence

The chat API receives extracted text and rendered PDF/DOCX/ODT page images rather than a
native PDF binary attachment. An application-generated `attachmentEvidence`
receipt preserves each original document's number, role, format, page count and
supplied representations through block review, synthesis and schema repair.
Derived observations are marked `review-notes` and carry
`reviewedAttachmentNumbers`; their container does not change the original
document's authorship. Prompts distinguish unavailable original images during
synthesis from a document that was never supplied. Receipt does not establish
readability, correctness or satisfaction of a rubric requirement.

PDF, DOCX and ODT evidence blocks keep each page's extracted text beside its rendered image.
A single unusually long page can still span text fragments. Every character and
image is retained, and original attachment numbers survive page splitting.
Evidence-note reduction stops if it does not shrink or exceeds four rounds;
failure leaves Moodle grades untouched.

Every PDF page is rendered locally, including pages with a text layer, and sent
as a PNG alongside extracted text. Rendering uses scale 2, capped at 2400 pixels
on the longest edge. From 0.1.77, a page whose PNG exceeds 1.2 MB of base64
(typical for scans and photos) is sent as JPEG, and a PDF whose page images
exceed 48 MB stops with an explicit error instead of exceeding Chrome's 64 MiB
message limit. The `imagePages` field maps image positions to original PDF
page numbers, including across evidence blocks. This requires an image-capable
model even for text-only PDFs. Ollama models must advertise vision support;
compatible server models must support image inputs. Transport tests verify image
pixels reaching a simulated provider; they do not establish any model's ability
to understand the supplied images. Very small screenshot text can still require
manual inspection of the original PDF.

### Ollama context length and large PDFs

The extension leaves Ollama's context length unchanged: chat requests do not set
`num_ctx`. The server's actual configuration applies, not the model's advertised
maximum or a context value selected in an unrelated chat client. Check the
allocated context and CPU/GPU split with `ollama ps` while a request is running.
See [Ollama context length](https://docs.ollama.com/context-length).

By default Ollama cuts a prompt that exceeds the allocated context without
reporting it. Ollama 0.40.11 shortened a 6,023-token request to 1,027 prompt
tokens in a 2,048-token context. From 0.1.74 every chat request sends
`truncate: false`, so an oversized request stops with an error such as
"request (6023 tokens) exceeds the available context size (2048 tokens)" and no
grades are applied. Increase the server context (for example
`OLLAMA_CONTEXT_LENGTH`) or reduce the material. Ollama versions that do not
support `truncate` ignore the field and keep their truncating behaviour.

A 128K context does not remove the independent 20 MB/file, 40 MB total, 60-page,
extraction, or operation deadlines. Evidence blocks remain limited to 24,000
characters and four images. A 60-page PDF therefore needs at least 15 visual
review requests plus synthesis, even if its text is short. Each block repeats
the assignment and rubric, which also consume context.

Larger context allocation increases model memory requirements; rendered PDF
pages add vision processing. With limited VRAM, CPU offloading or model loading
can dominate runtime. Start by comparing a 16K or 32K server context against the
same fictional PDF and inspect actual allocation and timing before increasing
it. These are diagnostic starting points, not a model-independent capacity
guarantee. The extension does not change server settings or unload other models.

`node tests/live-pdf-check.mjs` optionally checks a generated nine-page PDF
against an already-installed local `gemma4:e4b` model. Set `MCA_LIVE_MODEL` to
choose another installed vision model. It uses an isolated Chromium profile,
fictional evidence and per-request 128K context overrides; no server settings or
student records are changed. This is an opt-in model check, not a standard
offline test or a guarantee about arbitrary PDFs.
