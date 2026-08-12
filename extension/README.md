# MoodlIA Corrector

Chrome extension that extracts Moodle grading context, sends it to AI Runtime, and applies the teacher-reviewed result back into the Moodle grading form.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Click **Load unpacked**.
4. Select this project folder.
5. Copy this extension ID.
6. Open AI Runtime options and authorize this extension ID as a trusted caller.

The extension detects the installed AI Runtime extension automatically through the Chrome management API.

## Versioning

Increase `manifest.json` version with every extension change.

## Current Flow

1. Open a Moodle assignment grading page.
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
