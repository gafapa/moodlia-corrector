# MoodlIA Corrector

MoodlIA Corrector is a Chrome extension that helps teachers review Moodle assignment submissions and apply teacher-approved AI correction suggestions to Moodle grading forms.

## Structure

- `extension/`: Chrome extension source.
- `web/`: Reserved for product-specific static assets if they are still needed after `moodlia.com` is available.

The current implementation uses the external AI Runtime project. AI Runtime remains an independent general-purpose project and is not part of MoodlIA.

## Quality Checks

```bash
npm run check
```

The suite validates manifest assets, grader-page restrictions, AI Runtime configuration sanitization, correction parsing, rubric normalization, fallback behavior, and prompt constraints.
