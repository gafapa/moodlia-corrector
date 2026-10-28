<?php
// This file is part of MoodlIA Corrector.
//
// Creates the fictional fixture used by tests/moodle-lab-check.mjs on a
// disposable Moodle lab site (ghcr.io/gafapa/moodlia-lab:<branch>-core). Run it
// inside the container after /opt/moodlia-lab/runtime.php:
//
//   docker cp tests/moodle-lab/setup.php <container>:/tmp/mca-lab-setup.php
//   docker exec <container> php /tmp/mca-lab-setup.php
//
// It creates a course, an editing teacher, two students and an assignment with
// file and online text submissions and comment feedback, graded out of 10.
// Both students submit a generated one-page PDF with a text layer and an online
// text. The second student's grade is overridden and locked in the gradebook,
// so the grader shows no editable grade field for them.
//
// The same course gets two more assignments with an online text from the first
// student: one graded with a marking guide (two criteria out of 6 and 4) and
// one graded with a custom scale. TinyMCE is made the teacher's editor, so the
// feedback comments of every assignment use TinyMCE.
//
// Every run creates new uniquely named records. The last line of the output is
// the fixture as JSON, including the teacher's generated password: store it
// with restricted permissions and never in a repository. Never run this script
// on a site that holds real data.

define('CLI_SCRIPT', true);

$config = getenv('MOODLE_CONFIG') ?: '/var/www/html/config.php';
require($config);
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/filelib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->dirroot . '/grade/grading/lib.php');
require_once($CFG->dirroot . '/grade/grading/form/lib.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/assign/locallib.php');

if (!file_exists($CFG->dirroot . '/mod/assign/tests/generator/lib.php')) {
    cli_error('This Moodle code base has no mod_assign test generator (mod/assign/tests/generator/lib.php).');
}

/**
 * Build a one-page PDF whose text layer contains $text.
 *
 * @param string $text ASCII text without parentheses or backslashes
 * @return string PDF bytes
 */
function mca_lab_pdf(string $text): string {
    $content = 'BT /F1 14 Tf 30 100 Td (' . $text . ') Tj ET';
    $objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length ' . strlen($content) . " >>\nstream\n" . $content . "\nendstream",
    ];
    $pdf = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objects as $index => $object) {
        $offsets[] = strlen($pdf);
        $pdf .= ($index + 1) . " 0 obj\n" . $object . "\nendobj\n";
    }
    $xref = strlen($pdf);
    $pdf .= "xref\n0 " . (count($objects) + 1) . "\n0000000000 65535 f \n";
    foreach ($offsets as $offset) {
        $pdf .= sprintf("%010d 00000 n \n", $offset);
    }
    $pdf .= "trailer\n<< /Size " . (count($objects) + 1) . " /Root 1 0 R >>\nstartxref\n" . $xref . "\n%%EOF\n";
    return $pdf;
}

/**
 * Submit an online text, and optionally a PDF file, for a student, as the student would.
 *
 * @param assign $assign the assignment
 * @param stdClass $student the student
 * @param string|null $filename the submitted file name, or null for an online text only
 * @param string|null $pdf the PDF bytes, or null for an online text only
 * @param string $onlinetext HTML online text
 * @return stdClass the submission record
 */
function mca_lab_submit(assign $assign, stdClass $student, ?string $filename, ?string $pdf, string $onlinetext): stdClass {
    global $DB;
    $submission = $assign->get_user_submission($student->id, true);
    if ($filename !== null && $pdf !== null) {
        get_file_storage()->create_file_from_string([
            'contextid' => $assign->get_context()->id,
            'component' => 'assignsubmission_file',
            'filearea' => 'submission_files',
            'itemid' => $submission->id,
            'filepath' => '/',
            'filename' => $filename,
            'userid' => $student->id,
            'mimetype' => 'application/pdf',
        ], $pdf);
        $DB->insert_record('assignsubmission_file', (object) [
            'assignment' => $assign->get_instance()->id,
            'submission' => $submission->id,
            'numfiles' => 1,
        ]);
    }
    $DB->insert_record('assignsubmission_onlinetext', (object) [
        'assignment' => $assign->get_instance()->id,
        'submission' => $submission->id,
        'onlinetext' => $onlinetext,
        'onlineformat' => FORMAT_HTML,
    ]);
    $submission->status = ASSIGN_SUBMISSION_STATUS_SUBMITTED;
    $submission->timemodified = time();
    $DB->update_record('assign_submission', $submission);
    return $submission;
}

/**
 * Create an assignment with online text submissions and comment feedback.
 *
 * @param testing_data_generator $generator the data generator
 * @param stdClass $course the course
 * @param string $name the assignment name
 * @param string $intro HTML description
 * @param int $grade the maximum grade, or minus the scale id for a scale
 * @return assign the assignment
 */
function mca_lab_online_text_assign(testing_data_generator $generator, stdClass $course, string $name, string $intro, int $grade): assign {
    $instance = $generator->create_module('assign', [
        'course' => $course->id,
        'name' => $name,
        'intro' => $intro,
        'introformat' => FORMAT_HTML,
        'alwaysshowdescription' => 1,
        'grade' => $grade,
        'submissiondrafts' => 0,
        'sendstudentnotifications' => 0,
        'assignsubmission_file_enabled' => 0,
        'assignsubmission_onlinetext_enabled' => 1,
        'assignsubmission_onlinetext_wordlimit_enabled' => 0,
        'assignsubmission_onlinetext_wordlimit' => 0,
        'assignfeedback_comments_enabled' => 1,
        'assignfeedback_comments_commentinline' => 0,
        'assignfeedback_editpdf_enabled' => 0,
        'assignfeedback_file_enabled' => 0,
        'assignfeedback_offline_enabled' => 0,
    ]);
    [$course, $cm] = get_course_and_cm_from_instance($instance->id, 'assign');
    return new assign(context_module::instance($cm->id), $cm, $course);
}

global $DB;
\core\session\manager::set_user(get_admin());
$generator = new testing_data_generator();

// User tours could cover the grader page in a browser check.
if ($DB->get_manager()->table_exists('tool_usertours_tours')) {
    $DB->set_field('tool_usertours_tours', 'enabled', 0);
}

$suffix = bin2hex(random_bytes(4));
$markers = [
    'intro' => 'MCALABINTRO' . strtoupper($suffix),
    'pdf' => 'MCALABPDF' . strtoupper($suffix),
    'onlinetext' => 'MCALABTEXT' . strtoupper($suffix),
    'guide_text' => 'MCALABGUIDETEXT' . strtoupper($suffix),
    'scale_text' => 'MCALABSCALETEXT' . strtoupper($suffix),
];
$password = 'Lab-' . bin2hex(random_bytes(12)) . '!9';

$course = $generator->create_course([
    'fullname' => 'Corrector lab course ' . $suffix,
    'shortname' => 'MCA-LAB-' . strtoupper($suffix),
    'visible' => 1,
]);
$teacher = $generator->create_user([
    'username' => 'mcalab_teacher_' . $suffix,
    'password' => $password,
    'firstname' => 'Lab',
    'lastname' => 'Teacher',
    'email' => 'mcalab_teacher_' . $suffix . '@example.invalid',
]);
$student = $generator->create_user([
    'username' => 'mcalab_student_' . $suffix,
    'firstname' => 'Ada',
    'lastname' => 'Fictional',
    'email' => 'mcalab_student_' . $suffix . '@example.invalid',
]);
$lockedstudent = $generator->create_user([
    'username' => 'mcalab_locked_' . $suffix,
    'firstname' => 'Blaise',
    'lastname' => 'Fictional',
    'email' => 'mcalab_locked_' . $suffix . '@example.invalid',
]);
// TinyMCE first among the enabled editors and as the teacher's preference, so
// the feedback comments use TinyMCE on every supported branch.
if (!file_exists($CFG->dirroot . '/lib/editor/tiny/version.php')) {
    cli_error('This Moodle code base has no TinyMCE editor (lib/editor/tiny).');
}
$editors = array_values(array_filter(array_map('trim', explode(',', (string) ($CFG->texteditors ?? '')))));
$editors = array_values(array_unique(array_merge(['tiny'], array_diff($editors, ['tiny']), ['textarea'])));
set_config('texteditors', implode(',', $editors));
set_user_preference('htmleditor', 'tiny', $teacher->id);

$generator->enrol_user($teacher->id, $course->id, 'editingteacher');
$generator->enrol_user($student->id, $course->id, 'student');
$generator->enrol_user($lockedstudent->id, $course->id, 'student');

$instance = $generator->create_module('assign', [
    'course' => $course->id,
    'name' => 'Lab essay on photosynthesis',
    'intro' => '<p>Explain in two sentences how plants turn light into chemical energy. ' . $markers['intro'] . '</p>',
    'introformat' => FORMAT_HTML,
    'alwaysshowdescription' => 1,
    'grade' => 10,
    'submissiondrafts' => 0,
    'sendstudentnotifications' => 0,
    'assignsubmission_file_enabled' => 1,
    'assignsubmission_file_maxfiles' => 1,
    'assignsubmission_file_maxsizebytes' => 1048576,
    'assignsubmission_file_filetypes' => '',
    'assignsubmission_onlinetext_enabled' => 1,
    'assignsubmission_onlinetext_wordlimit_enabled' => 0,
    'assignsubmission_onlinetext_wordlimit' => 0,
    'assignfeedback_comments_enabled' => 1,
    'assignfeedback_comments_commentinline' => 0,
    'assignfeedback_editpdf_enabled' => 0,
    'assignfeedback_file_enabled' => 0,
    'assignfeedback_offline_enabled' => 0,
]);
[$course, $cm] = get_course_and_cm_from_instance($instance->id, 'assign');
$context = context_module::instance($cm->id);
$assign = new assign($context, $cm, $course);

$filename = 'lab-essay.pdf';
$pdf = mca_lab_pdf('Fictional lab answer: chloroplasts capture light energy ' . $markers['pdf']);
$onlinetext = '<p>Fictional online answer: glucose stores the captured energy. ' . $markers['onlinetext'] . '</p>';
mca_lab_submit($assign, $student, $filename, $pdf, $onlinetext);
mca_lab_submit($assign, $lockedstudent, $filename, $pdf, $onlinetext);

// Override and lock the second student's grade in the gradebook. Moodle then
// replaces the grade input in the grader with a static "grade locked" notice.
$gradeitem = grade_item::fetch([
    'courseid' => $course->id,
    'itemtype' => 'mod',
    'itemmodule' => 'assign',
    'iteminstance' => $instance->id,
    'itemnumber' => 0,
]);
if (!$gradeitem) {
    cli_error('The assignment has no grade item.');
}
$gradeitem->update_final_grade($lockedstudent->id, 6, 'mcalab', 'Overridden in the gradebook.', FORMAT_PLAIN);
$grade = grade_grade::fetch(['itemid' => $gradeitem->id, 'userid' => $lockedstudent->id]);
if (!$grade) {
    cli_error('The gradebook did not store the overridden grade.');
}
$grade->set_overridden(true);
$grade = grade_grade::fetch(['itemid' => $gradeitem->id, 'userid' => $lockedstudent->id]);
if (!$grade->set_locked(time())) {
    fwrite(STDERR, "The overridden grade could not be locked; it stays overridden only.\n");
}
if (!$assign->grading_disabled($lockedstudent->id)) {
    cli_error('Grading is still enabled for the overridden student.');
}
if ($assign->grading_disabled($student->id)) {
    cli_error('Grading is disabled for the first student.');
}

// Marking guide: an assignment out of 10 whose guide criteria add up to 10, so
// the gradebook grade equals the sum of the criterion scores.
$guideassign = mca_lab_online_text_assign($generator, $course, 'Lab guide essay on ecosystems',
    '<p>Describe one food chain with two interacting species.</p>', 10);
$gradingmanager = get_grading_manager($guideassign->get_context(), 'mod_assign', 'submissions');
$gradingmanager->set_active_method('guide');
$guidecontroller = $gradingmanager->get_controller('guide');
$guidecontroller->update_definition((object) [
    'name' => 'Lab marking guide ' . $suffix,
    'description_editor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => file_get_unused_draft_itemid()],
    'status' => gradingform_controller::DEFINITION_STATUS_READY,
    'guide' => [
        'criteria' => [
            'NEWID1' => [
                'sortorder' => 1,
                'shortname' => 'Content',
                'description' => 'The food chain names two species and how they interact.',
                'descriptionformat' => FORMAT_HTML,
                'descriptionmarkers' => 'Two interacting species, energy flow.',
                'descriptionmarkersformat' => FORMAT_HTML,
                'maxscore' => 6,
            ],
            'NEWID2' => [
                'sortorder' => 2,
                'shortname' => 'Clarity',
                'description' => 'The answer is short and clearly written.',
                'descriptionformat' => FORMAT_HTML,
                'descriptionmarkers' => 'Short paragraphs, no spelling errors.',
                'descriptionmarkersformat' => FORMAT_HTML,
                'maxscore' => 4,
            ],
        ],
        'comments' => [],
    ],
]);
$gradingmanager = get_grading_manager($guideassign->get_context(), 'mod_assign', 'submissions');
$guidecontroller = $gradingmanager->get_controller('guide');
if ($gradingmanager->get_active_method() !== 'guide' || !$guidecontroller->is_form_available()) {
    cli_error('The marking guide is not the active, ready grading method of the guide assignment.');
}
$guidecriteria = [];
foreach ($guidecontroller->get_definition()->guide_criteria as $criterionid => $criterion) {
    $criterion = (array) $criterion;
    $guidecriteria[] = [
        'id' => (int) $criterionid,
        // The grader names the inputs advancedgrading[criteria][<id>][score] in a row with this id.
        'dom_id' => 'advancedgrading-criteria-' . (int) $criterionid,
        'shortname' => $criterion['shortname'],
        'max_score' => (float) $criterion['maxscore'],
    ];
}
if (count($guidecriteria) !== 2) {
    cli_error('The marking guide was stored with ' . count($guidecriteria) . ' criteria instead of 2.');
}
mca_lab_submit($guideassign, $student, null, null,
    '<p>Fictional guide answer: rabbits eat grass and foxes eat rabbits. ' . $markers['guide_text'] . '</p>');

// Scale: an assignment graded with a custom course scale.
$scaleitems = ['Not yet', 'Approaching', 'Achieved', 'Excellent'];
$scale = $generator->create_scale([
    'name' => 'Lab scale ' . $suffix,
    'scale' => implode(',', $scaleitems),
    'courseid' => $course->id,
]);
$scaleassign = mca_lab_online_text_assign($generator, $course, 'Lab scale answer on the water cycle',
    '<p>Name the stages of the water cycle in order.</p>', -((int) $scale->id));
if ((int) $scaleassign->get_instance()->grade !== -((int) $scale->id)) {
    cli_error('The scale assignment is not graded with the lab scale.');
}
mca_lab_submit($scaleassign, $student, null, null,
    '<p>Fictional scale answer: evaporation, condensation, precipitation. ' . $markers['scale_text'] . '</p>');

purge_caches();

echo json_encode([
    'moodle_release' => $CFG->release,
    'moodle_branch' => $CFG->branch,
    'course_id' => (int) $course->id,
    'cmid' => (int) $cm->id,
    'assign_id' => (int) $instance->id,
    'max_grade' => 10,
    'teacher' => ['id' => (int) $teacher->id, 'username' => $teacher->username, 'password' => $password],
    'student' => ['id' => (int) $student->id, 'username' => $student->username],
    'locked_student' => ['id' => (int) $lockedstudent->id, 'username' => $lockedstudent->username],
    'submission_file' => $filename,
    'markers' => $markers,
    'teacher_editor' => 'tiny',
    'guide' => [
        'cmid' => (int) $guideassign->get_course_module()->id,
        'assign_id' => (int) $guideassign->get_instance()->id,
        'max_grade' => 10,
        'criteria' => $guidecriteria,
    ],
    'scale' => [
        'cmid' => (int) $scaleassign->get_course_module()->id,
        'assign_id' => (int) $scaleassign->get_instance()->id,
        'scale_id' => (int) $scale->id,
        'items' => $scaleitems,
    ],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
