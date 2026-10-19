# MoodlIA Corrector privacy policy

Effective date: 20 October 2026. Version covered: 0.1.65.

## Scope and contact

This policy describes the MoodlIA Corrector browser extension, maintained by the independent MoodlIA project. Contact: contact@moodlia.com. It supplements the website privacy policy. MoodlIA is not affiliated with Moodle HQ.

## What the extension processes

When you activate the extension on a Moodle assignment grading page, it reads the page context needed to assist grading: assignment instructions and references, submission text, supported attachments, rubric or marking-guide criteria, numeric grading controls and feedback fields. Student or course identifiers may be visible in the local panel. Teacher criteria can be saved by course, assignment, student and attempt. Additional files are included when selected by the teacher.

The extension distinguishes assignment references from student submissions. PDF, DOCX and ODT extraction and supported image preparation run locally using bundled libraries. Unsupported formats are marked and skipped. This does not mean a student submission has been assessed successfully.

## AI processing and recipients

When you request a correction, relevant assignment and submission evidence and teacher criteria are sent directly from the extension to the AI endpoint you selected. Available choices include Ollama, LM Studio, llama.cpp, LocalAI, vLLM and other OpenAI-compatible services. Refreshing models or testing a connection contacts that endpoint; the connection test uses fictional data.

MoodlIA does not run an intermediary AI service and does not receive student work, teacher criteria or API keys. Requests omit selected structured identity fields and original attachment filenames, but text and documents can themselves contain personal information. The extension does not guarantee anonymization. Select a provider approved by your institution and only process work you are authorized to use. Provider logging, retention, training and other processing are governed by that provider's terms and your institutional agreement, not by MoodlIA.

Initial Moodle downloads use the authenticated HTTPS Moodle session already available in the browser. Signed HTTPS file-storage redirects may be followed. Moodle cookies are omitted when a download leaves the original Moodle origin. Moodle passwords are not read or stored by the extension.

## Local storage and security

Saved non-secret preferences include provider addresses and models, chosen interface language, remembered Moodle installations and teacher criteria. They are stored in local extension storage, not synchronized through a MoodlIA account. API keys are stored in Chrome session storage, can be deleted from Advanced settings, and are cleared on provider/destination changes. Keys are not sent to Moodle. A key is sent only to the configured AI endpoint when needed for its API.

Remote API mode requires HTTPS. Configurable local-server modes allow HTTP, including an explicitly permitted server on a local network. HTTP is unencrypted and can expose submitted work and keys to network observers. Loopback HTTP stays on the device; LAN HTTP does not. Use HTTPS for sensitive network traffic. The extension displays this warning in settings and may request access to the chosen HTTP host. Extension-only request-header rules make supported local APIs accessible without changing operating-system or server configuration; unrelated website requests are unaffected.

## Retention, control and grading

Saved preferences and teacher criteria remain until changed, cleared in their scope, or the extension's local data is removed. Removing a site from automatic activation does not delete its teacher criteria or revoke separate network permissions. You can clear individual criteria, remove the session key, edit the endpoint, remove remembered activation or uninstall the extension. Diagnostic information is local; it is not sent to a MoodlIA analytics service.

Generated suggestions and manually added files are page-specific. Page/student changes reset correction state. AI output may fill editable Moodle grade and feedback fields, but the extension never submits or saves the Moodle grading form. The teacher must review the result and decide whether to save it. Moodle's retention of saved grades is controlled by the institution.

## Data-use commitments

MoodlIA does not sell extension data, use it for advertising, profile users, or provide it for unrelated human review. Data is used only for the user-facing correction functionality described above. MoodlIA Corrector's use and transfer of information adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements. No remotely hosted JavaScript or WebAssembly is downloaded or executed; executable code, extraction libraries and translations are bundled with the extension.

For questions or data requests about MoodlIA's own processing, contact contact@moodlia.com. For student records held by Moodle or an AI provider, contact the institution or relevant provider.
