# MoodlIA Corrector

Chrome extension that extracts Moodle grading context, sends it directly to the AI provider selected by the teacher or institution, and applies the teacher-reviewed result back into the Moodle grading form.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Click **Load unpacked**.
4. Select the `extension` folder from this project.
5. Open the extension details and select **Extension options**.
6. Choose Ollama or an OpenAI-compatible API, then provide the endpoint and model. Remote APIs also require an API key for the current Chrome session.

The API key is retained only in Chrome session storage. Provider, endpoint, and model are saved as non-secret preferences.

Remote providers must use HTTPS, and AI requests reject redirects. Moodle submission files are fetched only from the HTTPS origin of the active grading page. AI prompts omit the student's name, course name, Moodle URLs, and original filenames; assignment evidence, rubric content, and readable submitted content are still sent to the provider selected by the teacher.

## Versioning

Increase `manifest.json` version with every extension change.

## Current Flow

1. Open any HTTPS Moodle assignment grading page (`/mod/assign/view.php?action=grader`), including sites installed below a subdirectory.
2. Open the assistant panel and review the detected Moodle data.
3. Optional: paste an external correction JSON in step 0 and click **Apply JSON to Moodle**.
4. Optional: configure AI and click **Correct with AI** to request a structured JSON suggestion.
5. Review the filled Moodle fields before saving.

The extension never submits the Moodle grading form. The teacher remains responsible for reviewing and saving the final grade.

## External Correction JSON

Step 0 accepts one JSON object with this shape:

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
- `criterionId` is still supported but is optional.
- `levelIndex` is zero-based: the first visible level is `0`, the next is `1`, and so on.
- `criterionFeedback` is copied to the criterion comment textarea.

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
