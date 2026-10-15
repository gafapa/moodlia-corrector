# Assignment Supervision Validation — 0.1.45

Validated locally on 2026-10-09.

The open Moodle grader has its task title in the assignment navigation link, while the page `h1` on the task detail page contains the course name. The assignment description links an editable ODT worksheet. Read-only checks confirmed that the new selectors identify the task title and the worksheet's filename, format, and descriptive link label.

The updated Chromium regression fixture verifies:

- Task title detection without substituting the course heading.
- Description extraction from downloaded HTML parsed with DOMParser.
- One deduplicated ODT reference from two download links, including an encoded filename.
- Separation of reference files from submitted work, with duplicate submission links removed.
- A descriptive reference list in the supervision panel and an explicit statement that its content was not read.
- No reference file downloads and safe handling of malformed links.

All 16 unit tests and 9 Chromium integration checks pass. The live check returned only assignment metadata; no real submission or grading data was used in AI tests. The existing grading tab was not reloaded or changed because some comment fields differed from their initial values. No live Moodle grade was saved. The updated extension should be reloaded and the Moodle page refreshed when the user has finished preserving any pending edits.
