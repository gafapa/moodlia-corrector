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
