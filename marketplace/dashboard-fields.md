# Chrome Web Store dashboard fields

Version: 0.1.65. Prepared 20 October 2026. These statements describe the actual extension; they are not a claim of store approval.

## Store listing

- Name: MoodlIA Corrector
- Category: Education
- Default listing language: English; add Spanish, French, German, Portuguese (Brazil), Italian, Galician and Catalan from `listings/*.json`.
- Summary and detailed description: copy the corresponding JSON fields.
- Homepage: https://moodlia.com/products/corrector/
- Support: https://github.com/gafapa/moodlia-corrector/issues
- Privacy: https://moodlia.com/privacy/corrector.html — stable extension-specific policy, verified against the website source on 20 October 2026. Review it against the submitted extension behavior.
- Pricing: Free. No in-extension purchases or subscription managed by MoodlIA. Third-party providers may charge independently.
- Distribution: Public; select your intended countries in the dashboard.
- Mature content: No.

## Single purpose

Assist teachers in reviewing Moodle assignment submissions by generating AI feedback and grading suggestions with the teacher's chosen provider and filling editable Moodle grading fields for review. The extension never saves or submits the Moodle grading form.

## Data categories and use

Declare website content (assignment/submission text, files, rubric, grades and feedback), personally identifiable information that can be present in that content or local page context, and authentication information for the user-provided AI API key. Do not claim that no user data is handled merely because MoodlIA has no intermediary server. Moodle login passwords are not accessed. The extension does not collect unrelated browsing history, advertising identifiers, analytics, payments or location.

Purpose: user-facing extension functionality only. Correction evidence is transferred directly to the chosen provider on request. Model refresh and connection tests contact that provider separately. State that embedded personal data is not guaranteed to be anonymized. Do not mark all connections as encrypted: remote API mode and Moodle downloads use HTTPS, but local-server mode permits HTTP on loopback or a selected network host.

Confirm the dashboard certifications against this behavior: no sale, no unrelated use/transfer, no creditworthiness purpose. The included privacy policy states the Limited Use commitment.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Identify the current teacher-selected page when opening the toolbar and start manual activation there. |
| `scripting` | Inject the correction UI on a manually selected assignment grader and register persistent scripts for explicitly remembered Moodle installations. |
| `storage` | Save non-secret provider/model profiles, interface language, remembered activation and scoped teacher criteria locally; keep the API key in session storage. |
| `offscreen` | Run bundled PDF/DOCX/ODT extraction and image preparation in a local document context. No screen or microphone capture. |
| `webRequest` | Temporarily read redirect response headers for extension-initiated authenticated Moodle downloads and signed HTTPS storage redirects. |
| `declarativeNetRequestWithHostAccess` | Remove Origin only from extension-initiated loopback API requests and the explicitly configured HTTP server origin. These rules do not change Moodle or unrelated website requests. |
| Required `https://*/*` | Reach the user-selected HTTPS Moodle installation, authenticated attachment storage redirects and selected HTTPS AI APIs. Automatic content injection is limited separately to remembered assignment paths. This broad required access remains in the current build; do not describe it as a per-site-only permission model. |
| Required HTTP loopback origins | Connect to local AI APIs on localhost, 127.0.0.1 and IPv6 loopback. |
| Optional `http://*/*` | Request only the particular non-loopback HTTP server selected by the user. Refusal leaves the saved connection unchanged. |
| Web-accessible settings document | Embed Advanced settings in an extension-origin frame on a grader. A background-issued token binds authorization to its tab; unrelated or forged embedding does not expose settings. |

## Remote code

Answer No. All extension JavaScript, translation catalogs, PDF.js, fflate and extraction WebAssembly are bundled. AI JSON responses and file evidence are data, not executable code. The manifest permits local WebAssembly compilation for document processing; it does not allow remote executable scripts.

## Notes for review

Use `reviewer-instructions.md`. The publisher must supply a reachable dedicated Moodle teacher test account in the dashboard if reviewers cannot otherwise access a grader. Do not place credentials in public listings or this repository. Do not provide student data, a personal production account, or an institution's production AI key.
