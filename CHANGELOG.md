# Changelog

## 0.1.71 - 2026-10-24

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
