# Reviewer instructions

MoodlIA Corrector 0.1.65 assists teacher review of Moodle assignments. It is an independent project and does not require a separate MoodlIA plugin or subscription.

## Access information to enter privately in the review dashboard

The publisher must complete these fields with a dedicated non-production environment before requesting review:

- HTTPS Moodle test site URL and direct assignment grader URL ending in `/mod/assign/view.php?id=...&action=grader`.
- Dedicated teacher test username and password. Use fictional course and student records only.
- An available AI API endpoint and exact model ID. If authentication is necessary, provide a restricted temporary review key privately. Do not expose the API publicly without access control or use a production key.
- Any access restrictions, expiry date and contact email. Keep the review environment available during review; the kit does not provision a hosted Moodle or AI service.

## Functional review

1. Install the extension in Chrome 116 or later and open the supplied HTTPS assignment grader while signed in as the dedicated test teacher.
2. Click the extension icon. The popup contains Add site and Manage sites; the correction sidebar opens on the grader. Automatic activation is off until a site is explicitly remembered.
3. Open the AI settings icon in the sidebar. Simple mode selects provider/model; Advanced exposes endpoint protocol, IP/host, port, API path, full URL, model and session key. A separate options page is also available from Chrome.
4. Configure the supplied endpoint or a local compatible server you operate. Refresh models, select the exact model, save and test the connection. The test sends fictional data only. Network HTTP hosts may prompt for optional access; use a trusted network or HTTPS.
5. Inspect detected grading mode and evidence roles. Assignment documents are references; submitted work is assessed. Supported PDF, DOCX, ODT and text are extracted locally. Supported images need a vision model; unsupported files are shown as skipped.
6. Enter teacher criteria for course, assignment and case. Request a correction. Check that the proposed feedback/grade or rubric selection is reviewable and editable in Moodle. Do not save any real student's grade. The extension itself never submits the form.
7. Navigate to a different student or attempt. Old suggestions and manually added files reset; course/task criteria persist, and case criteria are isolated.
8. In Advanced settings choose another interface language and reload the Moodle page. Popup, panel and settings support English, Spanish, French, German, Portuguese, Italian, Galician and Catalan. The Moodle page and teacher-authored text are not translated.
9. Add the test Moodle in the popup, reload its grader to check remembered activation, then remove it through Manage sites. Reload to verify automatic activation is removed.

## Reproducible local evidence

For source review, `npm ci`, `npm run check`, `npx playwright install chromium`, `npm run test:browser`, and `npm run test:locales` run isolated fictional fixtures. The locale test regenerates actual extension screenshots over a Moodle-compatible demonstration fixture, not a production Moodle site. This automated harness supplements the private account review instructions; it is not a hosted reviewer login.
