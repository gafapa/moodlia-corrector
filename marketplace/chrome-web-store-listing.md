# Chrome Web Store listing — MoodlIA Corrector 0.1.43

## Product details

- **Store name:** MoodlIA Corrector
- **Category:** Education
- **Language:** English
- **Homepage:** `https://moodlia.com/products/corrector/`
- **Support URL:** `https://github.com/gafapa/moodlia-corrector/issues`
- **Privacy policy URL:** `https://moodlia.com/privacy/`
- **Mature content:** No
- **Price:** Free
- **Distribution:** Public, all supported regions

### Summary

Teacher-reviewed AI feedback suggestions for Moodle assignment grading pages.

### Detailed description

Grade Moodle assignments with AI assistance while keeping the teacher in control.

MoodlIA Corrector opens only on Moodle assignment grading pages. It reads the grading context already visible to the teacher, prepares a structured suggestion for feedback, score, and rubric levels, and fills the Moodle form for review. It never submits the grading form: the teacher checks every suggestion and decides whether to save it.

Use Ollama on your own computer or connect an OpenAI-compatible API approved by your institution. Choose the provider, endpoint, and model in the extension settings. Remote-provider API keys are retained only for the current Chrome session.

MoodlIA Corrector supports Moodle sites served over HTTPS, including Moodle installations located in a subdirectory. It works on assignment grader pages at `/mod/assign/view.php?action=grader`.

Before using an AI provider with student work, make sure that your institution authorises that provider and that its data-processing terms meet your requirements. The extension sends Moodle context directly to the provider selected by the teacher or institution. MoodlIA does not operate an AI service, receive Moodle data, sell data, profile users, or automatically save grades.

## Privacy practices

### Single purpose

Provide teacher-reviewed AI correction suggestions on Moodle assignment grading pages.

### User data handled

The extension may handle website content and user-generated content visible to the teacher on a Moodle assignment grading page, including course and assignment information, student name when displayed, submission text, selected text-file attachments, rubric or marking-guide information, grades, and feedback fields.

### Data use and transfer

Data is used only to provide the teacher-facing correction suggestion requested by the user. When the user selects an AI provider and requests a correction, the relevant Moodle context is transferred directly to that selected provider. MoodlIA does not receive the data. Data is not sold, used for advertising, used for profiling, or made available for human review by MoodlIA.

### Security statement

Remote AI providers are configured through HTTPS endpoints. An API key for a remote provider is retained only in Chrome session storage and is cleared when the Chrome session ends.

## Dashboard privacy answers

Use these answers in the Chrome Web Store Privacy practices tab.

- **Single purpose description:** Provide teacher-reviewed AI correction suggestions on Moodle assignment grading pages.
- **Does the extension collect or transmit user data?** Yes, only when the teacher requests a correction.
- **Data categories:** Website content and personally identifiable information. The latter is limited to student or teacher names when they are visible in the Moodle page context.
- **Data purpose:** Functionality. No analytics, personalisation, advertising, creditworthiness, or sale of data.
- **Data transfer:** The correction context is sent directly to the AI provider selected by the teacher or institution. MoodlIA does not receive it.
- **Encryption:** Yes. Remote provider endpoints must use HTTPS. Local Ollama traffic remains on the teacher's own device.
- **Limited Use:** Confirm compliance. The data is used only to provide the requested correction suggestion and is not sold, used for advertising, or used for unrelated purposes.
- **Remote hosted code:** No. The extension does not fetch or execute remotely hosted JavaScript or WebAssembly.
- **Permissions justification:** The `https://*/*` host permission is used only to recognise Moodle assignment grader pages at `/mod/assign/view.php?action=grader` on the Moodle site chosen by the teacher. `storage` keeps non-secret provider preferences locally and holds a remote API key in session storage only.

## Test instructions for reviewers

1. Install the extension in Chrome 116 or later.
2. Open the extension options page and configure either a local Ollama service or an OpenAI-compatible API, endpoint, and model. A remote API also requires an API key for the current Chrome session.
3. Sign in to an HTTPS Moodle site with a teacher account and open an assignment grader page with `action=grader`.
4. Open the MoodlIA Corrector panel from the floating button.
5. Check the detected assignment context, then request a correction suggestion.
6. Review the editable JSON and Moodle form values. The extension does not submit the grading form; save it manually only if the suggestion is appropriate.

## Graphic assets to attach

- Store icon: `extension/icons/icon-128.png` (128 × 128)
- Screenshot: attach a genuine 1280 × 800 capture of the extension panel on a non-production Moodle assignment page.
- Small promo tile: `marketplace/assets/promo-small.png` (440 × 280)
- Marquee promo tile: `marketplace/assets/promo-marquee.png` (1400 × 560)

## Final release gate

Before submitting for review, upload a genuine screenshot and make the homepage and privacy-policy URLs above publicly reachable with the same statements as this listing. Do not use student data in the screenshot; use a dedicated test course and fictional names.
