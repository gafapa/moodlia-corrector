(async () => {
if (document.getElementById("mca-side-panel-host")) return;
await MoodliaCorrectorI18n.init();
if (document.getElementById("mca-side-panel-host")) return;
const MOODLE_ASSIGNMENT_PATH = '/mod/assign/';
const MOODLE_GRADER_PATH = '/mod/assign/view.php';
const PANEL_WIDTH = 420;
const FLOATING_BUTTON_ID = 'mca-floating-button-host';
const PANEL_ID = 'mca-side-panel-host';
const PAGE_STYLE_ID = 'mca-page-layout-style';
const APP_INFO = {
  id: 'moodle-correction-assistant',
  name: 'MoodlIA Corrector',
  version: '0.2.5',
};
const ICON_SVG = `
  <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="mca-icon-gradient" x1="18" y1="14" x2="110" y2="114" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#2453a6"/>
        <stop offset="1" stop-color="#0f8b6f"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#mca-icon-gradient)"/>
    <path d="M36 32h38c7.7 0 14 6.3 14 14v8H72c-12.2 0-22 9.8-22 22v20H36c-7.7 0-14-6.3-14-14V46c0-7.7 6.3-14 14-14Z" fill="#fff"/>
    <path d="M38 51h30" stroke="#2453a6" stroke-width="7" stroke-linecap="round"/>
    <path d="M38 67h20" stroke="#2453a6" stroke-width="7" stroke-linecap="round"/>
    <path d="M76 88 62 74l8-8 6 6 20-22 9 8-29 30Z" fill="#0f8b6f"/>
  </svg>
`;

let currentAssignmentData = null;
let currentCorrection = null;
let originalPageStyles = null;
let aiRuntimeStatus = null;
let aiStatusRevision = 0;
let gradingPageRevision = 0;
let panelRefreshTimer = null;
let savedInstructionsReady = Promise.resolve();
let instructionsController = null;

const isSupportedGraderPage = (url) =>
  url.pathname.endsWith(MOODLE_GRADER_PATH) && url.searchParams.get('action') === 'grader';

const isSupportedGraderUrl = (url = window.location.href) => {
  try {
    const currentUrl = new URL(url);
    return (
      currentUrl.protocol === 'https:' &&
      isSupportedGraderPage(currentUrl)
    );
  } catch {
    return false;
  }
};

const getVisibleText = (element) => {
  if (!element) {
    return '';
  }

  return String(element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
};

// Preserve document structure and code indentation; compact label extraction
// above is intentionally separate from evidence extraction.
// layoutIndependent reads content that Moodle hides with CSS, such as the
// complete online text behind the grader's 140-character summary.
const getStructuredText = (element, { layoutIndependent = false } = {}) => {
  if (!element) return '';
  if (!layoutIndependent && element.ownerDocument?.defaultView && element.isConnected && typeof element.innerText === 'string') {
    return element.innerText.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  }
  const copy = element.cloneNode(true);
  copy.querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"], .expandsummaryicon').forEach(node => node.remove());
  copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  copy.querySelectorAll('td, th').forEach(node => node.after('\t'));
  copy.querySelectorAll('p, div, pre, li, tr, h1, h2, h3, h4, h5, h6, blockquote').forEach(node => {
    node.before('\n'); node.after('\n');
  });
  return String(copy.textContent || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
};

const onlineSubmissionSelectors = ['.assignsubmission_onlinetext', '[class*="assignsubmission_onlinetext"]', '[id*="assignsubmission_onlinetext"]', '.submissiontext'];
// Moodle's grader renders online text in summary mode: a visible summary
// shortened to 140 characters and the complete text in a CSS-hidden
// `.hidefull.full_assignsubmission_onlinetext_<id>` box. Read the complete box
// whenever it exists, independent of whether the teacher expanded it.
// A collapsed grading panel hides every container, so a second pass accepts
// hidden containers rather than silently sending no online text.
const getOnlineSubmissionContent = () => findOnlineSubmissionContent(true) || findOnlineSubmissionContent(false);
const findOnlineSubmissionContent = (requireVisible) => {
  for (const element of document.querySelectorAll(onlineSubmissionSelectors.join(', '))) {
    if (element.closest('.attempthistory') || requireVisible && !element.getClientRects().length) continue;
    if (!requireVisible && element.closest('[hidden], [aria-hidden="true"]')) continue;
    const full = element.matches('[class*="full_assignsubmission_onlinetext"]') ? element
      : element.querySelector('[class*="full_assignsubmission_onlinetext"]');
    if (full) return { root: full, complete: true };
    if (/\b(?:summary|full)_assignsubmission_onlinetext/.test(element.className)) {
      const container = element.closest('.assignsubmission_onlinetext');
      const sibling = container?.querySelector('[class*="full_assignsubmission_onlinetext"]');
      if (sibling) return { root: sibling, complete: true };
    }
    if (getStructuredText(element, { layoutIndependent: !requireVisible }).trim() || element.querySelector('img[src]')) return { root: element, complete: !requireVisible };
  }
  return null;
};

const extractOnlineSubmissionImages = () => {
  const files = [];
  let omitted = 0;
  const seen = new Set();
  const content = getOnlineSubmissionContent();
  for (const image of content?.root.querySelectorAll('img[src]') || []) {
    // The complete box is hidden by Moodle, so visibility only applies to inline content.
    if (image.closest('.expandsummaryicon') || image.classList.contains('icon')) continue;
    if (image.closest('[hidden], [aria-hidden="true"]')) continue;
    if (!content.complete && !image.getClientRects().length) continue;
    let url;
    try { url = new URL(image.getAttribute('src'), location.href); } catch { omitted++; continue; }
    // Only the online-text file area: other same-origin URLs could be files the
    // teacher can open but the student did not submit.
    if (url.protocol !== 'https:' || url.origin !== location.origin || !isMoodleFileAreaUrl(url, 'assignsubmission_onlinetext')) { omitted++; continue; }
    url.hash = '';
    url.searchParams.delete('forcedownload');
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    let originalName;
    try { originalName = decodeURIComponent(url.pathname.split('/').pop()); } catch { originalName = url.pathname.split('/').pop(); }
    files.push({ id: `online-image-${files.length + 1}`, name: `online-image-${files.length + 1}${getFileExtension(originalName)}`,
      originalName, url: url.href, source: 'online-text-image' });
  }
  return { files, omitted };
};

const findFirstText = (selectors) => {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = getVisibleText(element);
    if (text) {
      return text;
    }
  }
  return '';
};

const getFieldRows = (root = document) => {
  const rows = [
    ...root.querySelectorAll('tr, .generaltable .r0, .generaltable .r1, .form-group, .fitem'),
  ];

  return rows
    .map((row) => {
      const cells = [...row.querySelectorAll('th, td, label, .fitemtitle, .felement')];
      if (cells.length < 2) {
        return null;
      }

      const label = getVisibleText(cells[0]).replace(/:$/, '');
      const value = getVisibleText(cells.slice(1).find((cell) => getVisibleText(cell)) || cells[1]);

      return label && value ? { label, value } : null;
    })
    .filter(Boolean);
};

const getFirstMatchingFieldValue = (patterns) => {
  const fields = getFieldRows();
  const field = fields.find((item) => patterns.some((pattern) => pattern.test(item.label)));
  return field?.value || '';
};

const extractStudentName = () => {
  return (
    getFirstMatchingFieldValue([/student/i, /alumno/i, /alumna/i, /participante/i]) ||
    findFirstText([
      '[data-region="user-info"]',
      '.useridentity',
      '.fullname',
      '.submissionuser',
      '.grader-grading-panel .user',
    ])
  );
};

const extractCourseName = () => {
  const breadcrumbItems = [...document.querySelectorAll('.breadcrumb-item, nav[aria-label*="breadcrumb" i] li')];
  const labels = breadcrumbItems.map((item) => getVisibleText(item)).filter(Boolean);

  if (labels.length >= 2) {
    return labels.at(-2);
  }

  return findFirstText(['.page-context-header .page-header-headings h1', '#page-navbar a']);
};

// Moodle serves submission files through pluginfile.php, either as a path or,
// without slash arguments, as the ?file= parameter.
const isMoodleFileAreaUrl = (url, component) => {
  if (!/\/pluginfile\.php(?:\/|$)/i.test(url.pathname)) return false;
  const path = /\/pluginfile\.php$/i.test(url.pathname) ? url.searchParams.get('file') || '' : url.pathname.replace(/^.*?\/pluginfile\.php/i, '');
  // Moodle file URLs are /pluginfile.php/<contextid>/<component>/<filearea>/...
  return new RegExp(`^/\\d+/${component}/`, 'i').test(path);
};

const extractSubmissionFiles = () => {
  const links = [
    ...document.querySelectorAll(
      '.assignsubmission_file a, .fileuploadsubmission a, a[href*="pluginfile.php"], a[href*="/assignsubmission_file/"]',
    ),
  ];

  const seen = new Set();
  return links
    .filter((link) => {
      // Plagiarism reports and portfolio buttons share Moodle's file rows; only
      // the submission file area itself is student evidence.
      let url;
      try { url = new URL(link.href); } catch { return false; }
      if (!isMoodleFileAreaUrl(url, 'assignsubmission_file')) return false;
      // Previous attempts are listed in Moodle's attempt history, not as current evidence.
      if (link.closest('.attempthistory')) return false;
      const key = new URL(link.href);
      key.hash = '';
      key.searchParams.delete('forcedownload');
      if (seen.has(key.href)) return false;
      seen.add(key.href);
      return true;
    })
    .map((link, index) => {
      const label = getVisibleText(link) || link.getAttribute('title') || '';
      let pathName;
      try { pathName = decodeURIComponent(new URL(link.href).pathname.split('/').pop()); } catch { pathName = ''; }
      const originalName = getFileExtension(label) ? label : pathName || label || 'File';
      const extension = getFileExtension(originalName);

      return {
        id: `submission-file-${index + 1}`,
        name: `submission-file-${index + 1}${extension}`,
        originalName,
        url: link.href,
      };
    }).concat(extractOnlineSubmissionImages().files.filter(file => !seen.has(file.url)));
};

const getFileExtension = (fileName) => {
  const cleanName = String(fileName || '').split('?')[0].trim();
  const match = cleanName.match(/(\.[a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : '';
};


const extractOnlineText = () => {
  const content = getOnlineSubmissionContent();
  return getStructuredText(content?.root, { layoutIndependent: Boolean(content?.complete) });
};

const isSameOriginUrl = (url) => {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
};

const resolveDocumentUrl = (value, pageUrl) => {
  try { return new URL(value, pageUrl); } catch { return null; }
};

const extractAssignmentDescriptionLink = () => {
  const currentUrl = new URL(location.href);
  const links = [...document.querySelectorAll('[data-region="assignment-info"] a[href], .breadcrumb a[href], a[href]')];
  for (const link of links) {
    const url = resolveDocumentUrl(link.getAttribute('href'), currentUrl);
    if (!url || url.origin !== currentUrl.origin || !url.pathname.endsWith(MOODLE_GRADER_PATH) ||
        url.searchParams.get('id') !== currentUrl.searchParams.get('id') ||
        url.searchParams.has('userid') || url.searchParams.has('action') && url.searchParams.get('action') !== 'view') continue;
    return { label: getVisibleText(link) || link.getAttribute('title') || '', url: url.href };
  }
  currentUrl.search = `?id=${encodeURIComponent(currentUrl.searchParams.get('id') || '')}`;
  currentUrl.hash = '';
  return { label: '', url: currentUrl.href };
};

const cleanAssignmentTitle = (value = '') => String(value).replace(/^(?:Tarea|Tarefa|Assignment|Actividade)\s*:\s*/i, '').trim();

const extractAssignmentTitle = (doc = document, pageUrl = location.href) => {
  const currentUrl = new URL(pageUrl);
  for (const link of doc.querySelectorAll('[data-region="assignment-info"] a[href], .breadcrumb a[href], [data-region="grading-navigation"] a[href]')) {
    const url = resolveDocumentUrl(link.getAttribute('href'), pageUrl);
    if (url && url.origin === currentUrl.origin && url.pathname.endsWith(MOODLE_GRADER_PATH) &&
        url.searchParams.get('id') === currentUrl.searchParams.get('id') && !url.searchParams.has('userid') &&
        (!url.searchParams.has('action') || url.searchParams.get('action') === 'view')) {
      const title = cleanAssignmentTitle(getVisibleText(link));
      if (title) return title;
    }
  }
  const selectors = ['.activity-header h2', '.activity-header h1', '.page-header-headings h2', '#region-main .activityname'];
  if (currentUrl.searchParams.get('action') !== 'grader') selectors.push('#region-main h2', '.page-header-headings h1', 'h1');
  for (const selector of selectors) {
    const title = cleanAssignmentTitle(getVisibleText(doc.querySelector(selector)));
    if (title) return title;
  }
  return '';
};

const assignmentDescriptionSelectors = ['#intro', '.activity-description', '.intro', '[data-region="assignment-description"]', '.introattachments'];

const getAssignmentFileType = (extension) => ({
  '.odt': MoodliaCorrectorI18n.t('Documento de texto editable (ODT)'), '.docx': MoodliaCorrectorI18n.t('Documento de Word (DOCX)'), '.doc': MoodliaCorrectorI18n.t('Documento de Word (DOC)'),
  '.pdf': MoodliaCorrectorI18n.t('Documento PDF'), '.ods': MoodliaCorrectorI18n.t('Hoja de cálculo (ODS)'), '.xlsx': MoodliaCorrectorI18n.t('Hoja de cálculo (XLSX)'), '.xls': MoodliaCorrectorI18n.t('Hoja de cálculo (XLS)'),
  '.odp': MoodliaCorrectorI18n.t('Presentación (ODP)'), '.pptx': MoodliaCorrectorI18n.t('Presentación (PPTX)'), '.ppt': MoodliaCorrectorI18n.t('Presentación (PPT)'),
  '.zip': MoodliaCorrectorI18n.t('Archivo comprimido (ZIP)'), '.txt': MoodliaCorrectorI18n.t('Archivo de texto'), '.csv': MoodliaCorrectorI18n.t('Datos CSV'),
  '.png': MoodliaCorrectorI18n.t('Imagen PNG'), '.jpg': MoodliaCorrectorI18n.t('Imagen JPEG'), '.jpeg': MoodliaCorrectorI18n.t('Imagen JPEG'), '.webp': MoodliaCorrectorI18n.t('Imagen WebP'), '.gif': MoodliaCorrectorI18n.t('Imagen GIF'), '.svg': MoodliaCorrectorI18n.t('Imagen SVG'),
  '.mp4': MoodliaCorrectorI18n.t('Vídeo MP4'), '.mp3': MoodliaCorrectorI18n.t('Audio MP3'),
}[extension] || (MoodliaCorrectorAttachmentSupport.isText({ name: `file${extension}` }) ? MoodliaCorrectorI18n.t('Archivo de texto') : extension ? MoodliaCorrectorI18n.message`Archivo ${extension.slice(1).toUpperCase()}` : MoodliaCorrectorI18n.t('Archivo enlazado')));

const extractAssignmentFiles = (doc = document, pageUrl = location.href) => {
  const seen = new Set();
  const files = [];
  for (const container of doc.querySelectorAll(assignmentDescriptionSelectors.join(', '))) {
    for (const element of container.querySelectorAll('a[href], img[src]')) {
      const url = resolveDocumentUrl(element.getAttribute('href') || element.getAttribute('src'), pageUrl);
      if (!url || !['http:', 'https:'].includes(url.protocol)) continue;
      let name;
      try { name = decodeURIComponent(url.pathname.split('/').pop() || ''); } catch { name = url.pathname.split('/').pop() || ''; }
      const extension = getFileExtension(name);
      const introFile = /\/pluginfile\.php\/[^/]+\/mod_assign\/intro(?:attachment)?\//i.test(url.pathname);
      const download = element.getAttribute('download');
      if (!introFile && !download && !MoodliaCorrectorAttachmentSupport.isText({ name }) && !/\.(odt|docx?|pdf|ods|xlsx?|odp|pptx?|zip|txt|csv|png|jpe?g|webp|gif|svg|mp4|mp3)$/i.test(extension)) continue;
      const key = new URL(url);
      key.hash = '';
      key.searchParams.delete('forcedownload');
      if (seen.has(key.href)) continue;
      seen.add(key.href);
      const label = getVisibleText(element) || element.getAttribute('alt') || element.getAttribute('title') || '';
      files.push({
        id: `assignment-file-${files.length + 1}`, name: download || name || label || MoodliaCorrectorI18n.t('Archivo del enunciado'),
        label, url: url.href, extension, typeDescription: getAssignmentFileType(extension),
        source: 'assignment-description', embedded: element.tagName === 'IMG', contentRead: false,
      });
    }
  }
  return files;
};

const createAssignmentFileList = (files = []) => {
  const list = document.createElement('ul');
  list.className = 'plain-list';
  list.dataset.assignmentFiles = 'true';
  if (!files.length) {
    const item = document.createElement('li');
    item.textContent = MoodliaCorrectorI18n.t('No se han detectado archivos en la descripción de la tarea.');
    list.appendChild(item);
  }
  for (const file of files) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = file.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = file.name;
    const description = document.createElement('p');
    description.textContent = `${file.typeDescription}. ${file.embedded ? MoodliaCorrectorI18n.t('Imagen incluida en el enunciado.') : file.label || MoodliaCorrectorI18n.t('Archivo enlazado desde el enunciado.')}`;
    const state = document.createElement('p');
    state.className = 'hint';
    state.textContent = MoodliaCorrectorI18n.t('Material de referencia del enunciado, no trabajo del alumno. Su contenido se leerá al solicitar la corrección con IA, si el formato y el acceso son compatibles.');
    item.append(link, description, state);
    list.appendChild(item);
  }
  return list;
};

const extractDescriptionFromDocument = (doc) => {
  for (const selector of assignmentDescriptionSelectors) {
    const element = doc.querySelector(selector);
    const text = getStructuredText(element);
    if (text) {
      return text;
    }
  }

  return '';
};

// The description page is the same for every student of an assignment: it is
// fetched once and reused while the grader stays on that assignment. Failed
// fetches are not kept, so the next extraction tries again.
let assignmentDescriptionCache = null;
const fetchAssignmentDescription = async (descriptionLink) => {
  if (!descriptionLink?.url || !isSameOriginUrl(descriptionLink.url)) {
    return null;
  }
  // Callers number and mark the files, so each extraction gets its own copies.
  const copy = ({ title, text, files }) => ({ ...descriptionLink, title, text, files: files.map(file => ({ ...file })) });
  if (assignmentDescriptionCache?.url === descriptionLink.url) return copy(assignmentDescriptionCache.result);
  const result = await fetchAssignmentDescriptionPage(descriptionLink);
  if (result.error) return result;
  assignmentDescriptionCache = { url: descriptionLink.url, result };
  return copy(result);
};

const fetchAssignmentDescriptionPage = async (descriptionLink) => {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(descriptionLink.url, {
      credentials: 'include',
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...descriptionLink,
        text: '',
        error: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = extractAssignmentTitle(doc, descriptionLink.url) || cleanAssignmentTitle(descriptionLink.label);

    return {
      ...descriptionLink,
      title,
      text: extractDescriptionFromDocument(doc),
      files: extractAssignmentFiles(doc, descriptionLink.url),
    };
  } catch (error) {
    return {
      ...descriptionLink,
      text: '',
      error: error.message || String(error),
    };
  } finally { clearTimeout(timer); }
};

const getPageContext = () => ({
  title: document.title,
  url: location.href,
  language: document.documentElement.lang || document.documentElement.getAttribute('xml:lang') || navigator.language || '',
  detectedAsMoodleAssignment: location.pathname.includes(MOODLE_ASSIGNMENT_PATH),
});

const getInstructionContext = () => {
  const url = new URL(location.href);
  const basePath = url.pathname.slice(0, url.pathname.lastIndexOf('/mod/assign/'));
  let courseId = document.body.className.match(/\bcourse-(\d+)\b/)?.[1] || '';
  if (!courseId) {
    for (const link of document.querySelectorAll('a[href*="/course/view.php"]')) {
      try {
        const course = new URL(link.href);
        if (course.origin === url.origin && course.pathname === `${basePath}/course/view.php` && /^\d+$/.test(course.searchParams.get('id') || '')) {
          courseId = course.searchParams.get('id');
          break;
        }
      } catch { /* Ignore malformed course links. */ }
    }
  }
  return {
    site: `${url.origin}${basePath}`, courseId,
    assignmentId: url.searchParams.get('id') || '',
    userId: getGradedUserId(),
    attemptId: getGradedAttemptNumber(),
  };
};

// The grader loads its form through core_get_fragment, where the hidden
// `userid` input renders optional_param('userid', 0): it is "0" for every
// student. The Quickform marker `_qf__mod_assign_grade_form_<userid>` and the
// grader URL carry the real user.
const getGradedUserId = () => {
  for (const input of document.querySelectorAll('input[name^="_qf__mod_assign_grade_form_"]')) {
    const id = input.name.match(/_(\d+)$/)?.[1];
    if (id && id !== '0') return id;
  }
  const fromUrl = new URL(location.href).searchParams.get('userid');
  if (/^[1-9]\d*$/.test(fromUrl || '')) return fromUrl;
  const fromInput = document.querySelector('input[name="userid"]')?.value || '';
  return /^[1-9]\d*$/.test(fromInput) ? fromInput : '';
};

// Moodle uses attempt -1 for "the latest attempt". Resolve it to the real
// number, so a reopened attempt does not reuse the previous attempt's notes.
const getGradedAttemptNumber = () => {
  const candidates = [document.querySelector('input[name="attemptnumber"]')?.value, new URL(location.href).searchParams.get('attemptnumber')];
  const explicit = candidates.find(value => /^\d+$/.test(value || ''));
  if (explicit) return explicit;
  const attempts = [...document.querySelectorAll('input[name="select-attemptnumber"]')]
    .map(input => Number(input.value)).filter(Number.isInteger);
  return attempts.length ? String(Math.max(...attempts)) : '0';
};

// This snapshot stays inside the extension; it is excluded from the AI prompt.
const getGradingContext = () => {
  const url = new URL(location.href);
  return JSON.stringify({
    revision: gradingPageRevision,
    page: `${url.origin}${url.pathname}`,
    assignment: url.searchParams.get('id'),
    user: url.searchParams.get('userid'),
    attempt: url.searchParams.get('attemptnumber'),
    formUser: getGradedUserId(),
    student: extractStudentName(),
    submission: extractSubmissionText(),
    files: extractSubmissionFiles().map((file) => file.url),
    maxScore: extractMaxScore(),
    rubric: extractRubric().map(({ id, levels }) => ({ id, levels: levels.map(({ id, value, text, score, index }) => ({ id, value, text, score, index })) })),
    guide: extractGradingGuide().map(({ id, maxScore }) => ({ id, maxScore })),
    scale: extractGradeScaleOptions(),
  });
};

const assertGradingContext = (expected) => {
  if (!expected || expected !== getGradingContext()) {
    throw Object.assign(new Error(MoodliaCorrectorI18n.t('El alumno, la tarea o la entrega han cambiado. Vuelve a extraer los datos y solicita otra corrección.')), { gradingContextChanged: true });
  }
};

const extractMaxScore = () => {
  const input = findGradeInput();
  if (!input) return null;
  const declared = input.getAttribute('max');
  if (declared?.trim() && Number.isFinite(Number(declared)) && Number(declared) >= 0) return Number(declared);
  const labels = [
    ...[...(input.labels || [])].map(getVisibleText),
    input.getAttribute('aria-label') || '',
    ...(input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => getVisibleText(document.getElementById(id))),
  ];
  for (const label of labels) {
    const match = label.match(/(?:calificaci[oó]n|cualificaci[oó]n|grade|score|nota|puntuaci[oó]n)\s*(?:sobre|out\s+of|maximum|max\.?|m[aá]xima|\/)\s*[:(]?\s*(\d+(?:[.,]\d+)?)/i);
    if (match) return Number(match[1].replace(',', '.'));
  }
  // Moodle's "gradeoutof" label is translated ("Note sur 20", "Bewertung (von 100)",
  // "Qualificació sobre 10"...). A grade label with exactly one number states the maximum.
  for (const label of labels) {
    const numbers = label.match(/\d+(?:[.,]\d+)?/g) || [];
    if (numbers.length === 1) return Number(numbers[0].replace(',', '.'));
  }
  return null;
};

const gradingModeParts = (assignmentData) => {
  const labels = { 'simple-direct': MoodliaCorrectorI18n.t('Calificación directa simple'), rubric: MoodliaCorrectorI18n.t('Rúbrica'), 'grading-guide': MoodliaCorrectorI18n.t('Guía de evaluación') };
  const label = labels[assignmentData?.correctionMethod] || MoodliaCorrectorI18n.t('Método no detectado');
  if (assignmentData?.correctionMethod === 'grading-guide') {
    const criteria = (assignmentData.gradingGuide || []).filter(criterion => criterion.controls?.score && Number.isFinite(Number(criterion.maxScore)) && criterion.maxScore !== null);
    // A frozen guide (grade locked or overridden in the gradebook) has no score inputs.
    if (!criteria.length) return [label, MoodliaCorrectorI18n.t('las puntuaciones por criterio se introducen a mano')];
    return [label, MoodliaCorrectorI18n.message`sobre ${criteria.reduce((sum, criterion) => sum + Number(criterion.maxScore), 0)}`];
  }
  if (assignmentData?.gradingControls?.gradeScale) return [MoodliaCorrectorI18n.t('Escala'), MoodliaCorrectorI18n.message`${(assignmentData.gradeScaleOptions || []).length} valores`];
  if (assignmentData?.correctionMethod !== 'simple-direct') return [label];
  return [label, assignmentData.maxScore === null ? MoodliaCorrectorI18n.t('máximo no detectado') : MoodliaCorrectorI18n.message`sobre ${assignmentData.maxScore}`];
};
const describeGradingMode = (assignmentData) => {
  const [label, detail] = gradingModeParts(assignmentData);
  return detail ? MoodliaCorrectorI18n.message`Modo: ${label} · ${detail}` : MoodliaCorrectorI18n.message`Modo: ${label}`;
};

const getUniqueElements = (elements) => {
  const seen = new Set();
  return elements.filter((element) => {
    if (!element || seen.has(element)) {
      return false;
    }
    seen.add(element);
    return true;
  });
};

const ensureAssistantDomId = (element, prefix, index) => {
  if (!element) {
    return '';
  }

  if (!element.dataset.mcaDomId) {
    element.dataset.mcaDomId = `${prefix}-${index + 1}`;
  }

  return element.dataset.mcaDomId;
};

const getRubricRoot = () => {
  const explicitRoot = document.querySelector('.gradingform_rubric, [data-grading-method="rubric"], #rubric-advancedgrading');
  if (explicitRoot) {
    return explicitRoot;
  }

  const criterion = [...document.querySelectorAll('[id^="advancedgrading-criteria-"]:not([id*="-levels-"])')]
    .find((element) => !element.closest('.gradingform_guide'));
  return criterion?.closest('table, tbody, form, [data-region="grade"]') || null;
};

const getRubricCriterionElements = (root = getRubricRoot()) => {
  if (!root) {
    return [];
  }

  const isRealCriterion = (element) => {
    const text = getVisibleText(element);
    const hasCriterionDescription = Boolean(
      element.querySelector(':scope > .description, :scope > th, :scope > .criteriondescription, .criteriondescription'),
    );
    const hasLevelControls = getRubricLevelElements(element).length > 0;
    return Boolean(text && hasCriterionDescription && hasLevelControls);
  };

  const primaryCriteria = getUniqueElements([
    ...root.querySelectorAll('tr.criterion, .criterion'),
  ]).filter(isRealCriterion);

  if (primaryCriteria.length > 0) {
    return primaryCriteria;
  }

  return getUniqueElements([
    ...root.querySelectorAll('[id^="advancedgrading-criteria-"]'),
  ]).filter((element) => /^advancedgrading-criteria-\d+$/.test(element.id || '') && isRealCriterion(element));
};

const getLabelControl = (label) => {
  if (!label?.htmlFor) {
    return null;
  }

  return document.getElementById(label.htmlFor);
};

const getRubricLevelElements = (criterionElement) => {
  if (!criterionElement) {
    return [];
  }

  const candidates = [
    ...criterionElement.querySelectorAll(
      'td.level[role="radio"], .levels td.level, .level[role="radio"], label[for*="level" i], input[type="radio"][name*="[levelid]"]',
    ),
  ].map((element) => (element.matches('input[type="radio"]') ? element.closest('.level, td, label') || element : element));

  return getUniqueElements(candidates)
    .filter((element) => {
      const text = getVisibleText(element);
      return (
        text ||
        element.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"]') ||
        (element.matches('label') && getLabelControl(element))
      );
    });
};

const getRubricLevelScore = (levelElement) =>
  getVisibleText(levelElement?.querySelector?.('.scorevalue, .score'))
    .match(/-?\d+(?:[.,]\d+)?/)?.[0]
    ?.replace(',', '.') ||
  levelElement?.getAttribute?.('data-score') ||
  levelElement?.getAttribute?.('data-points') ||
  null;

const findLevelInput = (levelElement, criterionElement = null, levelIndex = -1) => {
  const directInput = levelElement?.querySelector?.('input[type="radio"], input[type="checkbox"]') || null;
  if (directInput) {
    return directInput;
  }

  const associatedInput = levelElement?.matches?.('label') ? getLabelControl(levelElement) : null;
  if (associatedInput) {
    return associatedInput;
  }

  if (criterionElement && levelIndex >= 0) {
    return [...criterionElement.querySelectorAll('input[type="radio"], input[type="checkbox"]')][levelIndex] || null;
  }

  return null;
};

const findLevelInputByValue = (criterionElement, levelValue = '') => {
  if (!criterionElement || !levelValue) {
    return null;
  }

  return (
    [...criterionElement.querySelectorAll('input[type="radio"], input[type="checkbox"]')].find(
      (input) => String(input.value) === String(levelValue),
    ) || null
  );
};

const findLevelInputByValues = (criterionElement, levelValues = []) => {
  for (const levelValue of levelValues) {
    const input = findLevelInputByValue(criterionElement, levelValue);
    if (input) {
      return input;
    }
  }

  return null;
};

const getRubricLevelValue = (levelElement) => {
  if (!levelElement) {
    return '';
  }

  const classMatch = String(levelElement.className || '').match(/(?:levelid|level-id)[_-]?(\d+)/i);
  if (classMatch?.[1]) {
    return classMatch[1];
  }

  const levelId =
    levelElement.getAttribute('data-level-id') ||
    levelElement.getAttribute('data-levelid') ||
    levelElement.getAttribute('aria-value') ||
    levelElement.querySelector('[data-level-id], [data-levelid]')?.getAttribute('data-level-id') ||
    levelElement.querySelector('[data-level-id], [data-levelid]')?.getAttribute('data-levelid') ||
    '';

  if (levelId) {
    return levelId;
  }

  const idMatch = levelElement.id?.match(/levels?[-_](\d+)/i) || levelElement.id?.match(/level[-_](\d+)/i);
  if (idMatch?.[1]) {
    return idMatch[1];
  }

  const onclickMatch = String(levelElement.getAttribute('onclick') || '').match(/(?:levelid|level|levels)[^0-9]+(\d+)/i);
  if (onclickMatch?.[1]) {
    return onclickMatch[1];
  }

  return '';
};

const getRubricLevelCandidateValues = (levelDefinition = null, levelElement = null) =>
  [
    levelDefinition?.value,
    levelDefinition?.levelValue,
    levelDefinition?.levelId,
    levelDefinition?.id,
    getRubricLevelValue(levelElement),
    levelDefinition?.score,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value));

const findRubricLevelElementByValue = (criterionElement, levelValue = '') => {
  if (!criterionElement || !levelValue) {
    return null;
  }

  return (
    getRubricLevelElements(criterionElement).find(
      (levelElement) => String(getRubricLevelValue(levelElement)) === String(levelValue),
    ) || null
  );
};

const findRubricLevelElementByValues = (criterionElement, levelValues = []) => {
  for (const levelValue of levelValues) {
    const levelElement = findRubricLevelElementByValue(criterionElement, levelValue);
    if (levelElement) {
      return levelElement;
    }
  }

  return null;
};

const findRubricLevelHiddenInput = (criterionElement) => {
  if (!criterionElement) {
    return null;
  }

  return (
    criterionElement.querySelector(
      'input[type="hidden"][name*="[levelid]"], input[type="hidden"][name*="levelid" i], input[type="hidden"][id*="levelid" i]',
    ) ||
    null
  );
};

const getElementControlType = (element) => {
  if (!element) {
    return 'none';
  }

  if (element.matches?.('input[type="radio"]')) {
    return 'radio';
  }

  if (element.matches?.('input[type="checkbox"]')) {
    return 'checkbox';
  }

  if (element.matches?.('textarea')) {
    return 'textarea';
  }

  if (element.matches?.('input')) {
    return 'input';
  }

  if (element.matches?.('[contenteditable="true"]')) {
    return 'rich-text';
  }

  return element.getAttribute?.('role') || element.tagName?.toLowerCase() || 'element';
};

const extractRubric = () => {
  const rubricRoot = getRubricRoot();
  if (!rubricRoot) {
    return [];
  }

  const criterionRows = getRubricCriterionElements(rubricRoot);

  return criterionRows
    .map((row, index) => {
      const fallbackId = ensureAssistantDomId(row, 'criterion', index);
      const id =
        row.getAttribute('data-criterion-id') ||
        row.id ||
        row.querySelector('input[name*="criterion" i]')?.name ||
        fallbackId;
      row.dataset.mcaCriterionId = id;

      const description =
        getVisibleText(row.querySelector('.description, .criteriondescription, th')) ||
        getVisibleText(row).slice(0, 500);

      const levelNodes = getRubricLevelElements(row);

      const levels = levelNodes.map((levelNode, levelIndex) => {
        const input = findLevelInput(levelNode, row, levelIndex);
        levelNode.dataset.mcaLevelIndex = String(levelIndex);
        if (input) {
          input.dataset.mcaCriterionId = id;
          input.dataset.mcaLevelIndex = String(levelIndex);
        }

        return {
          index: levelIndex,
          text: getVisibleText(levelNode),
          value: input?.value || getRubricLevelValue(levelNode) || null,
          score: getRubricLevelScore(levelNode),
          selectable: Boolean(input || levelNode.matches('[role="radio"], label') || levelNode.onclick),
          selected:
            Boolean(input?.checked) ||
            levelNode.classList.contains('checked') ||
            levelNode.classList.contains('selected') ||
            levelNode.getAttribute('aria-checked') === 'true',
        };
      });

      const commentBox = findCriterionCommentBox(row);
      return {
        id,
        description,
        levels,
        controls: {
          levelSelection: levels.some((level) => level.selectable),
          criterionComment: Boolean(commentBox),
          criterionCommentType: getElementControlType(commentBox),
        },
      };
    })
    .filter((criterion) => criterion.description || criterion.levels.length > 0);
};

// Moodle marking guide (gradingform_guide renderer, unchanged from 4.5 to 5.2):
// <div class="gradingform_guide evaluate editable"><table class="criteria"><tr class="criterion" id="advancedgrading-criteria-12">
// <td class="descriptionreadonly"><div class="criterionshortname"/><div class="criteriondescription"/><div class="criteriondescriptionmarkers"/></td>
// <td class="remark"><textarea name="advancedgrading[criteria][12][remark]"/></td>
// <td class="score"><input type="text" name="advancedgrading[criteria][12][score]"/><div>/10</div></td></tr>.
// A locked or overridden grade renders "evaluate frozen" with no score input; review and view modes are read-only.
const getGuideRoot = () => document.querySelector('.gradingform_guide, [data-grading-method="guide"]');

const isGuideFrozen = (element) => Boolean(element?.closest('.gradingform_guide.frozen, .gradingform_guide.review, .gradingform_guide.view'));

const getGuideCriterionElements = (root = getGuideRoot()) => root
  ? getUniqueElements([...root.querySelectorAll('.criterion, tr[id*="criterion" i], [data-criterion-id]')])
    .filter((row) => !row.closest('table.comments') && !/-comments-/.test(row.id || '') && !row.parentElement?.closest('.criterion, [data-criterion-id]'))
  : [];

const findGuideScoreInput = (row) => row?.querySelector('input[name$="[score]"], input[id$="-score"]') || null;
const findGuideRemarkBox = (row) => row?.querySelector('textarea[name$="[remark]"], textarea[id$="-remark"]') || null;

const getGuideMaxScore = (row) => {
  const declared = findGuideScoreInput(row)?.getAttribute('max');
  if (declared?.trim() && Number.isFinite(Number(declared))) return Number(declared);
  const text = getVisibleText(row.querySelector('td.score, .score')) || getVisibleText(row.querySelector('.criteriondescriptionscore'));
  const match = text.match(/\/\s*(\d+(?:[.,]\d+)?)/) || (row.querySelector('.criteriondescriptionscore') ? text.match(/(\d+(?:[.,]\d+)?)/) : null);
  return match ? Number(match[1].replace(',', '.')) : null;
};

const extractGradingGuide = () => {
  const guideRoot = getGuideRoot();
  if (!guideRoot) {
    return [];
  }

  return getGuideCriterionElements(guideRoot)
    .map((row, index) => {
      const scoreInput = findGuideScoreInput(row);
      const remarkBox = findGuideRemarkBox(row);
      const shortName = getVisibleText(row.querySelector('.criterionshortname'));
      // textContent: Moodle hides the student or marker descriptions with a "hide" class by user preference.
      const description = (row.querySelector('.criteriondescription, .description')?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        id: row.getAttribute('data-criterion-id') || row.id || `guide-criterion-${index + 1}`,
        shortName,
        description: description || shortName || getVisibleText(row.querySelector('th')) || getVisibleText(row).slice(0, 500),
        markerDescription: (row.querySelector('.criteriondescriptionmarkers')?.textContent || '').replace(/\s+/g, ' ').trim(),
        maxScore: getGuideMaxScore(row),
        controls: {
          score: Boolean(scoreInput && !isGuideFrozen(scoreInput) && isWritableElement(scoreInput)),
          remark: Boolean(remarkBox && !isGuideFrozen(remarkBox) && isWritableElement(remarkBox)),
        },
      };
    })
    .filter((criterion) => criterion.description);
};

const findGuideCriterionElement = (criterionId) => getGuideCriterionElements().find((row, index) =>
  (row.getAttribute('data-criterion-id') || row.id || `guide-criterion-${index + 1}`) === criterionId) || null;

// Scale grading renders <select name="grade"> with "-1" for "No grade" and one option per scale item.
// A locked grade is frozen by Moodle into static text, so it has no select.
const findGradeScaleSelect = () => [...document.querySelectorAll('select#id_grade, select[name="grade"]')]
  .find((select) => !select.disabled) || null;

const extractGradeScaleOptions = (select = findGradeScaleSelect()) => [...(select?.options || [])]
  .map((option) => ({ value: option.value, label: option.textContent.replace(/\s+/g, ' ').trim() }))
  .filter((option) => option.value !== '-1' && option.value !== '' && option.label);

const extractCorrectionMethod = () => {
  const rubric = extractRubric();
  if (rubric.length > 0) {
    return {
      type: 'rubric',
      rubric,
      guide: [],
    };
  }

  const guide = extractGradingGuide();
  if (guide.length > 0) {
    return {
      type: 'grading-guide',
      rubric: [],
      guide,
    };
  }

  return {
    type: findGradeInput() ? 'simple-direct' : 'manual',
    rubric: [],
    guide: [],
  };
};

const extractSubmissionText = () => {
  const onlineText = extractOnlineText();
  if (onlineText) {
    return onlineText;
  }

  return '';
};

const isMoodleLoadingNode = (element) =>
  Boolean(
    element?.querySelector?.(
      'img[src*="/y/loading"], img[title*="Cargando" i], img[alt*="Cargando" i], .loadingicon, .spinner',
    ),
  );

const isGradingPanelReady = () => {
  const gradePanel = document.querySelector('[data-region="grade"]');
  if (!gradePanel || isMoodleLoadingNode(gradePanel)) {
    return false;
  }

  return Boolean(
    gradePanel.querySelector(
      '.gradingform_rubric, [data-grading-method="rubric"], #rubric-advancedgrading, [id*="advancedgrading"][id*="criteria"], input[name*="[levelid]"], .gradingform_guide, [data-grading-method="guide"], textarea, input[name*="grade" i], [contenteditable="true"]',
    ) || getVisibleText(gradePanel).length > 40,
  );
};

const waitForGradingPanelReady = (timeoutMs = 30_000) => {
  if (isGradingPanelReady()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (ready) => {
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(ready);
    };

    const observer = new MutationObserver(() => {
      if (isGradingPanelReady()) {
        finish(true);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    const timeoutId = setTimeout(() => finish(isGradingPanelReady()), timeoutMs);
  });
};

// Resolves once the page has had no DOM changes for quietMs (or after maxMs).
const waitForQuietPage = (quietMs = 500, maxMs = 5000) => new Promise((resolve) => {
  let quietTimer;
  const finish = () => { clearTimeout(quietTimer); clearTimeout(maxTimer); observer.disconnect(); resolve(); };
  const observer = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); });
  const maxTimer = setTimeout(finish, maxMs);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  quietTimer = setTimeout(finish, quietMs);
});

// A real Moodle grader keeps filling the student's form after it appears, which
// resets the panel as a page change. Extraction for the same student and attempt
// is repeated once the page is quiet, up to three times.
const extractAssignmentData = async () => {
  for (let attempt = 1; ; attempt++) {
    const studentKey = currentStudentKey();
    try {
      return await extractAssignmentDataOnce();
    } catch (error) {
      if (attempt >= 3 || !error.gradingContextChanged || currentStudentKey() !== studentKey) throw error;
      await waitForQuietPage();
    }
  }
};

const extractAssignmentDataOnce = async () => {
  await waitForGradingPanelReady();
  const gradingContext = getGradingContext();
  const descriptionLink = extractAssignmentDescriptionLink();
  const linkedDescription = await fetchAssignmentDescription(descriptionLink);
  const submissionFiles = extractSubmissionFiles();
  const correctionMethod = extractCorrectionMethod();
  const finalFeedbackBox = findCommentBox();
  const gradeInput = findGradeInput();
  const gradeScaleOptions = extractGradeScaleOptions();
  const rubric = correctionMethod.rubric;
  const inlinePrompt = extractDescriptionFromDocument(document);
  const assignmentFiles = extractAssignmentFiles(document);
  const omittedOnlineImages = extractOnlineSubmissionImages().omitted;
  for (const file of linkedDescription?.files || []) {
    if (!assignmentFiles.some((existing) => existing.url === file.url)) assignmentFiles.push(file);
  }
  assignmentFiles.forEach((file, index) => { file.id = `assignment-file-${index + 1}`; });
  assertGradingContext(gradingContext);

  return {
    gradingContext,
    page: getPageContext(),
    instructionContext: getInstructionContext(),
    courseName: extractCourseName(),
    studentName: extractStudentName(),
    assignmentTitle: extractAssignmentTitle() || linkedDescription?.title || cleanAssignmentTitle(descriptionLink?.label),
    assignmentDescriptionLink: descriptionLink,
    linkedAssignmentDescription: linkedDescription,
    assignmentPrompt: linkedDescription?.text || inlinePrompt,
    assignmentFiles,
    correctionMethod: correctionMethod.type,
    submissionStatus: getFieldRows(document).slice(0, 30),
    submissionFiles,
    submissionText: extractSubmissionText(),
    submissionImageLimitations: omittedOnlineImages
      ? [{ reason: 'inline-images-outside-moodle-or-unsupported-url', count: omittedOnlineImages }] : [],
    rubric,
    gradingGuide: correctionMethod.guide,
    gradeScaleOptions: gradeInput ? [] : gradeScaleOptions,
    gradingControls: {
      grade: Boolean(gradeInput),
      gradeType: getElementControlType(gradeInput),
      // Scale grading renders a select; the AI chooses one of its item labels.
      gradeScale: !gradeInput && gradeScaleOptions.length > 0,
      guideCriteriaWithScoreInputs: correctionMethod.guide.filter((criterion) => criterion.controls.score).length,
      guideCriteriaWithRemarkBoxes: correctionMethod.guide.filter((criterion) => criterion.controls.remark).length,
      finalFeedback: Boolean(finalFeedbackBox),
      finalFeedbackType: getElementControlType(finalFeedbackBox),
      rubricCriteriaWithLevelControls: rubric.filter(
        (criterion) => criterion.controls?.levelSelection,
      ).length,
      rubricCriteriaWithCommentBoxes: rubric.filter(
        (criterion) => criterion.controls?.criterionComment,
      ).length,
    },
    maxScore: extractMaxScore(),
  };
};

const findGradeInput = () => {
  for (const selector of ['#id_grade', 'input[name="grade"]', '[data-region="grade"] input[name*="grade" i]']) {
    // Marking guide score inputs ("advancedgrading[criteria][12][score]") are not the grade.
    const candidate = [...document.querySelectorAll(selector)].find((input) =>
      ['text', 'number'].includes(input.type) && !input.disabled && !input.readOnly && !/^advancedgrading\[/i.test(input.name || ''));
    if (candidate) return candidate;
  }
  return null;
};

const findCommentBox = () => {
  const selectors = [
    'textarea[name="assignfeedbackcomments_editor[text]"]',
    'textarea[name*="assignfeedbackcomments" i]',
    'textarea[id*="assignfeedbackcomments" i]',
    '#id_assignfeedbackcomments_editor textarea',
    '#id_assignfeedbackcomments_editor',
    '#id_assignfeedbackcomments_editoreditable',
    '[id*="assignfeedbackcomments_editor"][contenteditable="true"]',
    '[id*="assignfeedbackcomments"][contenteditable="true"]',
    '.assignfeedback_comments textarea',
    '.assignfeedback_comments [contenteditable="true"]',
    '[data-fieldtype="editor"] textarea[name*="comment" i]',
    'textarea[name*="comment" i]:not([name*="remark" i]):not([name*="criteria" i])',
    'textarea[id*="comment" i]:not([id*="remark" i]):not([id*="criteria" i])',
    '[contenteditable="true"][id*="assignfeedbackcomments" i]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return null;
};

const findAssociatedEditable = (element) => {
  if (!element) {
    return null;
  }

  if (element.matches?.('[contenteditable="true"]')) {
    return element;
  }

  const id = element.id || '';
  const candidates = [];
  if (id) {
    candidates.push(
      `#${CSS.escape(id)}editable`,
      `#${CSS.escape(id)}_editable`,
      `#${CSS.escape(id)}-editable`,
      `[data-field="${CSS.escape(id)}"] [contenteditable="true"]`,
    );
  }

  const wrapper = element.closest?.('.editor_atto, .editor_tiny, [data-fieldtype="editor"], .form-group, .fitem, .felement');
  if (wrapper) {
    candidates.push('[contenteditable="true"]');
  }

  for (const selector of candidates) {
    const editable = (wrapper || document).querySelector(selector);
    if (editable) {
      return editable;
    }
  }

  return null;
};

const setTinyMceIframeValue = (element, value, markup = null) => {
  const id = element?.id || '';
  if (!id) {
    return false;
  }

  const frame = document.getElementById(`${id}_ifr`);
  const body = frame?.contentDocument?.body;
  if (!body) {
    return false;
  }

  if (markup === null) body.textContent = value;
  else body.innerHTML = markup;
  body.dispatchEvent(new Event('input', { bubbles: true }));
  body.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

const findCriterionElement = (criterionId) => getRubricCriterionElements().find(criterion =>
  criterion.id === criterionId || criterion.dataset.mcaCriterionId === criterionId ||
  criterion.getAttribute('data-criterion-id') === criterionId ||
  criterion.querySelector('input[name*="criterion" i]')?.name === criterionId) || null;

const findCriterionCommentBox = (criterionElement) => {
  if (!criterionElement) {
    return null;
  }

  const selectors = [
    'textarea[name*="remark" i]',
    'textarea[id*="remark" i]',
    'textarea[name*="comment" i]',
    'textarea[id*="comment" i]',
    'input[type="text"][name*="remark" i]',
    '[contenteditable="true"]',
  ];

  for (const selector of selectors) {
    const element = criterionElement.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return null;
};

const isWritableElement = (element) => Boolean(element && !element.matches(':disabled') && !element.readOnly &&
  !element.closest('[inert], [aria-disabled="true"]') &&
  (!element.id || document.getElementById(`${element.id}_ifr`)?.contentDocument?.body?.getAttribute('contenteditable') !== 'false'));

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Moodle stores editor feedback as HTML. Escape the AI text and keep its
// paragraphs and line breaks; nothing in it is interpreted as markup.
const textToHtml = (text) => String(text).replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)
  .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');

// An editor (TinyMCE, Atto) or an explicit FORMAT_HTML (1) means the field holds HTML.
const isHtmlFeedbackField = (element) => {
  const name = element?.getAttribute?.('name') || '';
  const format = name.endsWith('[text]') ? document.querySelector(`[name="${CSS.escape(name.replace(/\[text\]$/, '[format]'))}"]`)?.value : undefined;
  if (format !== undefined && format !== '') return format === '1';
  return Boolean(element?.matches?.('[contenteditable="true"]') || findAssociatedEditable(element) ||
    element?.id && document.getElementById(`${element.id}_ifr`));
};

// FORMAT_MOODLE (0) keeps line breaks but is cleaned as HTML when shown, so "<stdio.h>" must be escaped.
const isMoodleFormatField = (element) => {
  const name = element?.getAttribute?.('name') || '';
  return name.endsWith('[text]') && document.querySelector(`[name="${CSS.escape(name.replace(/\[text\]$/, '[format]'))}"]`)?.value === '0';
};

const setElementValue = (element, value, { html = false } = {}) => {
  if (!isWritableElement(element)) {
    return false;
  }

  const editable = findAssociatedEditable(element);
  const markup = html ? textToHtml(value) : null;

  if ('value' in element) {
    element.value = markup ?? value;
  } else if (markup !== null) {
    element.innerHTML = markup;
  } else {
    element.textContent = value;
  }

  if (editable && editable !== element) {
    if (markup !== null) editable.innerHTML = markup;
    else editable.textContent = value;
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
  }
  setTinyMceIframeValue(element, value, markup);

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
};

const clickElement = (element) => {
  if (!element) {
    return false;
  }

  if (typeof PointerEvent === 'function') {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  }
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.click();
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

const selectInputChoice = (input) => {
  if (!isWritableElement(input)) {
    return false;
  }

  if (input.checked) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  clickElement(input);

  if (!input.checked) {
    input.checked = true;
    input.setAttribute('checked', 'checked');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return Boolean(input.checked);
};

const markRubricLevelElement = (criterionElement, targetLevel, input = null) => {
  if (!targetLevel) {
    return false;
  }

  const selectedInput = input || targetLevel.querySelector?.('input[type="radio"], input[type="checkbox"]') || null;
  for (const level of getRubricLevelElements(criterionElement)) {
    const selected = level === targetLevel || level.contains(targetLevel);
    level.classList.toggle('checked', selected);
    level.classList.toggle('selected', selected);
    if (level.getAttribute('role') === 'radio') {
      level.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
  }

  if (selectedInput) {
    const peerInputs = selectedInput.name
      ? [...criterionElement.querySelectorAll(`input[type="radio"][name="${CSS.escape(selectedInput.name)}"]`)]
      : [selectedInput];

    for (const peerInput of peerInputs) {
      const selected = peerInput === selectedInput;
      peerInput.checked = selected;
      if (selected) {
        peerInput.setAttribute('checked', 'checked');
      } else {
        peerInput.removeAttribute('checked');
      }
      peerInput.dispatchEvent(new Event('input', { bubbles: true }));
      peerInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  targetLevel.dispatchEvent(new Event('input', { bubbles: true }));
  targetLevel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

const getRubricSelectionTarget = (criterionElement, levelIndex, expectedLevelValues = []) => {
  const expectedValues = Array.isArray(expectedLevelValues)
    ? expectedLevelValues.map((value) => String(value))
    : [String(expectedLevelValues || '')].filter(Boolean);
  const levelNodes = getRubricLevelElements(criterionElement);
  const targetLevel = levelNodes[levelIndex] || findRubricLevelElementByValues(criterionElement, expectedValues) || null;
  const levelValues = getRubricLevelCandidateValues(null, targetLevel);
  const candidateValues = [...new Set([...expectedValues, ...levelValues])];

  const input = findLevelInputByValues(criterionElement, candidateValues) || findLevelInput(targetLevel, criterionElement, levelIndex);
  return { expectedValues, levelNodes, targetLevel, candidateValues, input };
};

// Moodle renders a rubric in DISPLAY_EVAL_FROZEN mode ("evaluate frozen")
// when the grade is locked or overridden in the gradebook. Its hidden levelid
// inputs are displayed but never saved, so writing them would falsely report success.
const isRubricFrozen = (criterionElement) => Boolean(criterionElement?.closest('.gradingform_rubric.frozen, .gradingform_rubric.review, .gradingform_rubric.view'));

const selectRubricLevel = (criterionElement, levelIndex, expectedLevelValues = []) => {
  if (!criterionElement || !Number.isInteger(levelIndex)) {
    return { applied: false, reason: 'missing-criterion-or-level-index' };
  }
  const { expectedValues, levelNodes, targetLevel, candidateValues, input } = getRubricSelectionTarget(criterionElement, levelIndex, expectedLevelValues);
  if (isRubricFrozen(criterionElement) || !isWritableElement(criterionElement) || input && !isWritableElement(input) || targetLevel && !isWritableElement(targetLevel)) {
    return { applied: false, reason: 'locked-grading-field' };
  }

  if (input) {
    if (targetLevel) {
      clickElement(targetLevel);
    }
    const selected = selectInputChoice(input);
    markRubricLevelElement(criterionElement, targetLevel || input.closest('.level, td, label'), input);
    return {
      applied: selected,
      reason: selected ? undefined : 'input-not-checked-after-selection',
      method: targetLevel ? 'cell+input' : 'input',
      levelCount: levelNodes.length,
      levelIndex,
      expectedLevelValues: candidateValues,
      inputName: input.name || '',
      inputValue: input.value || '',
      inputType: input.type || '',
    };
  }

  if (targetLevel) {
    const hiddenLevelInput = findRubricLevelHiddenInput(criterionElement);
    const levelValue = getRubricLevelValue(targetLevel) || expectedValues[0] || '';
    if (hiddenLevelInput && levelValue) {
      setElementValue(hiddenLevelInput, levelValue);
    }
    clickElement(targetLevel);
    markRubricLevelElement(criterionElement, targetLevel);
    return {
      applied: true,
      method: hiddenLevelInput && levelValue ? 'hidden+cell' : 'cell',
      levelCount: levelNodes.length,
      levelIndex,
      expectedLevelValues: candidateValues,
      hiddenName: hiddenLevelInput?.name || '',
      hiddenValue: hiddenLevelInput?.value || '',
      levelValue,
    };
  }

  return {
    applied: false,
    reason: 'target-level-not-found',
    levelCount: levelNodes.length,
    levelIndex,
    expectedLevelValues: expectedValues,
  };
};

const getRubricCriterionDefinition = (selection = {}) =>
  (currentAssignmentData?.rubric || []).find(criterion => criterion.id === selection.criterionId) || null;

const getRubricLevelDefinition = (criterionDefinition = null, levelIndex = -1) => {
  if (!criterionDefinition || !Number.isInteger(levelIndex)) {
    return null;
  }

  return (
    (criterionDefinition.levels || []).find((level) => Number(level?.index) === levelIndex) ||
    null
  );
};

const applyRubricSelections = (rubricSelections) => {
  if (!Array.isArray(rubricSelections)) {
    return { levelsApplied: 0, commentsApplied: 0, details: [] };
  }

  let applied = 0;
  let commentsApplied = 0;
  const details = [];

  for (const [selectionIndex, selection] of rubricSelections.entries()) {
    const criterionId = selection?.criterionId;
    const levelIndex = selection?.levelIndex;
    if (!Number.isInteger(levelIndex)) {
      details.push({
        selectionIndex,
        criterionId: criterionId || '',
        applied: false,
        commentApplied: false,
        reason: 'invalid-level-index',
      });
      continue;
    }

    const criterionDefinition = getRubricCriterionDefinition(selection);
    const criterion = findCriterionElement(criterionId);
    const levelDefinition = getRubricLevelDefinition(criterionDefinition, levelIndex);
    const expectedLevelValues = getRubricLevelCandidateValues(levelDefinition);
    const levelResult = selectRubricLevel(criterion, levelIndex, expectedLevelValues);

    if (levelResult.applied) {
      applied += 1;
    }

    const criterionFeedback =
      selection?.criterionFeedback ||
      selection?.feedback ||
      selection?.comment ||
      selection?.reason ||
      '';

    const commentBox = findCriterionCommentBox(criterion);
    const commentApplied = Boolean(criterionFeedback && setElementValue(commentBox, criterionFeedback));
    if (commentApplied) {
      commentsApplied += 1;
    }

    details.push({
      selectionIndex,
      criterionId: criterionId || '',
      criterionFound: Boolean(criterion),
      commentFound: Boolean(commentBox),
      commentApplied,
      ...levelResult,
    });
  }

  return {
    levelsApplied: applied,
    commentsApplied,
    details,
  };
};

const applyCorrection = (correction) => {
  const parsedInput = correction?.parsed || correction;
  const rawScore = parsedInput?.score;
  const maximum = getExpectedMaxScore(currentAssignmentData || {});
  if (rawScore !== undefined && rawScore !== null &&
      (!['number', 'string'].includes(typeof rawScore) || String(rawScore).trim() === '' ||
       !Number.isFinite(Number(rawScore)) || Number(rawScore) < 0 || maximum !== null && Number(rawScore) > maximum)) {
    throw new Error(MoodliaCorrectorI18n.t('La nota no es válida para esta tarea. Revisa la corrección antes de aplicarla.'));
  }
  if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) throw new Error(MoodliaCorrectorI18n.t('La corrección debe ser un objeto JSON.'));
  const parsed = normalizeCorrectionResponse(parsedInput, currentAssignmentData || {});
  if (!parsed) throw new Error(MoodliaCorrectorI18n.t('El JSON no contiene una corrección válida.'));
  if (parsed.guideScores?.some((entry) => entry.score === null || !entry.remark)) {
    throw new Error(MoodliaCorrectorI18n.t('La guía de evaluación necesita una puntuación válida y un comentario para cada criterio. Revisa la corrección antes de aplicarla.'));
  }
  if (parsed?.needsRepair || parsed?.rubricSelections?.some((selection) => !Number.isInteger(selection.levelIndex))) {
    throw new Error(MoodliaCorrectorI18n.t('La rúbrica contiene una selección inválida. Revisa la corrección antes de aplicarla.'));
  }
  const scaleProvided = typeof parsedInput.scaleGrade === 'string' && parsedInput.scaleGrade.trim() !== '';
  if (scaleProvided && !parsed.scaleGrade) {
    throw new Error(MoodliaCorrectorI18n.t('La nota de escala no coincide con ningún valor de la escala de Moodle. Revisa la corrección antes de aplicarla.'));
  }
  const scaleSelect = parsed.scaleGrade ? findGradeScaleSelect() : null;
  const scaleOption = scaleSelect && (currentAssignmentData?.gradeScaleOptions || []).find((option) => option.label === parsed.scaleGrade);
  if (parsed.scaleGrade && (!scaleSelect || !scaleOption || ![...scaleSelect.options].some((option) => option.value === scaleOption.value) || !isWritableElement(scaleSelect))) {
    throw new Error(MoodliaCorrectorI18n.t('Moodle has locked a grading field. Unlock it or reload the grading page before applying a correction.'));
  }
  const guideTargets = (parsed.guideScores || []).map((entry) => {
    const row = findGuideCriterionElement(entry.criterionId);
    return { entry, row, scoreInput: findGuideScoreInput(row), remarkBox: findGuideRemarkBox(row) };
  });
  // A frozen guide (grade locked or overridden in the gradebook) is never written, like a frozen rubric.
  if (guideTargets.some(({ row, scoreInput, remarkBox }) => !row || !scoreInput || isGuideFrozen(row) ||
      !isWritableElement(scoreInput) || remarkBox && !isWritableElement(remarkBox))) {
    throw new Error(MoodliaCorrectorI18n.t('Moodle has locked a grading field. Unlock it or reload the grading page before applying a correction.'));
  }
  for (const selection of parsed.rubricSelections || []) {
    const definition = getRubricCriterionDefinition(selection);
    const criterion = findCriterionElement(selection.criterionId);
    const level = getRubricLevelDefinition(definition, selection.levelIndex);
    if (!definition || !criterion || !level) {
      throw new Error(MoodliaCorrectorI18n.t('No se ha podido identificar el criterio de rúbrica. Actualiza los datos antes de aplicar.'));
    }
    const target = getRubricSelectionTarget(criterion, selection.levelIndex, getRubricLevelCandidateValues(level));
    const hidden = findRubricLevelHiddenInput(criterion);
    const comment = findCriterionCommentBox(criterion);
    if (isRubricFrozen(criterion) || !isWritableElement(criterion) || !target.targetLevel && !target.input ||
        [target.targetLevel, target.input, hidden, comment].some(element => element && !isWritableElement(element))) {
      throw new Error(MoodliaCorrectorI18n.t('Moodle has locked a grading field. Unlock it or reload the grading page before applying a correction.'));
    }
  }
  const feedback = parsed?.studentFeedback || parsed?.feedback || '';
  const score = parsed?.score;
  const commentBox = findCommentBox();
  const gradeInput = findGradeInput();
  // Validate all known targets before the first Moodle field or editor is changed.
  if (feedback && commentBox && (!isWritableElement(commentBox) ||
      findAssociatedEditable(commentBox) && !isWritableElement(findAssociatedEditable(commentBox)))) {
    throw new Error(MoodliaCorrectorI18n.t('Moodle has locked a grading field. Unlock it or reload the grading page before applying a correction.'));
  }

  const commentApplied = feedback
    ? setElementValue(commentBox, isMoodleFormatField(commentBox) ? escapeHtml(feedback) : feedback, { html: isHtmlFeedbackField(commentBox) })
    : false;
  const gradeApplied =
    score !== undefined && score !== null ? setElementValue(gradeInput, String(score)) : false;
  const rubricApplied = applyRubricSelections(parsed?.rubricSelections);
  // Moodle's validation uses is_numeric(), so scores are written with a dot decimal separator.
  const guideDetails = guideTargets.map(({ entry, scoreInput, remarkBox }) => ({
    criterionId: entry.criterionId,
    scoreApplied: setElementValue(scoreInput, String(entry.score)),
    remarkApplied: Boolean(remarkBox && setElementValue(remarkBox, entry.remark)),
  }));
  const scaleApplied = Boolean(scaleOption && setElementValue(scaleSelect, scaleOption.value));
  const guideRoot = getGuideRoot();
  const result = {
    // The proposed score, before validation drops it for a form without a grade field.
    scoreProvided: rawScore !== undefined && rawScore !== null,
    // A graded assignment whose form shows no grade input: Moodle's static "grade locked" element
    // (gradedisabled), or a detected maximum. The AI was then not asked for a score.
    gradeExpected: maximum !== null || Boolean(document.querySelector('#fitem_id_gradedisabled, #id_gradedisabled')) || Boolean(guideRoot),
    scaleProvided: Boolean(parsed.scaleGrade),
    scaleApplied,
    guideScoreCount: guideTargets.length,
    guideCriteriaFound: getGuideCriterionElements(guideRoot).filter((row) => !isGuideFrozen(row) && isWritableElement(findGuideScoreInput(row))).length,
    guideScoresApplied: guideDetails.filter((detail) => detail.scoreApplied).length,
    guideRemarksApplied: guideDetails.filter((detail) => detail.remarkApplied).length,
    guideDetails,
    feedbackProvided: Boolean(feedback),
    commentFound: Boolean(commentBox),
    gradeFound: Boolean(gradeInput),
    rubricSelectionCount: Array.isArray(parsed?.rubricSelections) ? parsed.rubricSelections.length : 0,
    rubricCriteriaFound: getRubricCriterionElements().length,
    commentApplied,
    gradeApplied,
    rubricLevelsApplied: rubricApplied.levelsApplied,
    rubricCommentsApplied: rubricApplied.commentsApplied,
    rubricDetails: rubricApplied.details,
  };

  addPanelDiagnostic('apply.result', result);

  return result;
};

// The status says what Moodle actually received: a grade locked or overridden in the
// gradebook has no input, and some forms have no feedback box.
const appliedStatus = (result) => {
  const gradeMissing = result?.scoreProvided && !result.gradeApplied && !result.rubricSelectionCount && !result.guideScoreCount && !result.scaleApplied ||
    result?.scaleProvided && !result.scaleApplied ||
    result?.guideScoreCount > 0 && result.guideScoresApplied < result.guideScoreCount ||
    result?.gradeExpected && !result.gradeFound && !result.rubricCriteriaFound && !result.guideCriteriaFound;
  const commentMissing = result?.feedbackProvided && !result.commentApplied;
  if (gradeMissing && commentMissing) return MoodliaCorrectorI18n.t('No se ha podido aplicar ni la nota ni los comentarios: Moodle no muestra campos editables. Copia la sugerencia a mano.');
  if (gradeMissing) return MoodliaCorrectorI18n.t('Comentarios aplicados, pero no la nota: Moodle no muestra un campo de nota editable (puede estar bloqueada o modificada en el libro de calificaciones). Introdúcela a mano.');
  if (commentMissing) return MoodliaCorrectorI18n.t('Nota aplicada, pero no se ha encontrado el cuadro de comentarios. Copia los comentarios a mano desde la sugerencia.');
  return MoodliaCorrectorI18n.t('Corrección aplicada en Moodle. Revisa la nota y los comentarios antes de guardar.');
};

const applyCorrectionWhenReady = async (correction) => {
  await waitForGradingPanelReady();
  assertGradingContext(correction?.gradingContext || currentAssignmentData?.gradingContext);
  return applyCorrection(correction);
};

const sendBackgroundMessage = (message) => MoodliaCorrectorRuntime.send(message);

const { getExpectedMaxScore, getFinalComment, normalizeCorrectionResponse } = MoodliaCorrectorSchema;

// Status text for the progress the service worker reports during a correction.
const progressStatus = (progress = {}) => {
  const { current, total } = progress;
  switch (progress.stage) {
    case 'plan': return MoodliaCorrectorI18n.message`Se enviarán ${Number(progress.pages) || 0} página(s), ${Number(progress.images) || 0} imagen(es) y unos ${Math.round(Number(progress.estimatedTokens) || 0).toLocaleString()} tokens en ${Number(progress.blocks) || 1} bloque(s).`;
    case 'download': return MoodliaCorrectorI18n.message`Descargando archivos de Moodle (${current} de ${total})...`;
    case 'read': return MoodliaCorrectorI18n.message`Leyendo archivos (${current} de ${total})...`;
    case 'model': return MoodliaCorrectorI18n.t('Comprobando el modelo...');
    case 'review': return MoodliaCorrectorI18n.message`Revisando la evidencia por bloques (${current} de ${total})...`;
    case 'grade': return MoodliaCorrectorI18n.t('Redactando la corrección...');
    case 'repair': return MoodliaCorrectorI18n.t('Completando la respuesta de la IA...');
    default: return '';
  }
};

let activeCorrectionRequestId = null;
const requestAiCorrectionFromPage = async (assignmentData, { onProgress } = {}) => {
  if (activeCorrectionRequestId) throw new Error(MoodliaCorrectorI18n.t('Ya hay una corrección en curso.'));
  const gradingContext = assignmentData.gradingContext;
  assertGradingContext(gradingContext);
  const requestId = crypto.randomUUID();
  activeCorrectionRequestId = requestId;
  try {
    const response = await MoodliaCorrectorRuntime.send({
      type: 'mca.correctAssignment',
      assignmentData,
      requestId,
    }, { onProgress: progress => { if (activeCorrectionRequestId === requestId) onProgress?.(progress); } });

    assertGradingContext(gradingContext);
    if (!response?.ok) {
      throw new Error(response?.error || MoodliaCorrectorI18n.t('La corrección con IA ha fallado.'));
    }

    return { ...response.correction, gradingContext };
  } finally {
    if (activeCorrectionRequestId === requestId) activeCorrectionRequestId = null;
  }
};

const cancelCorrectionFromPage = async () => {
  if (!activeCorrectionRequestId) return;
  const response = await sendBackgroundMessage({ type: 'mca.cancelCorrection', requestId: activeCorrectionRequestId });
  if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido cancelar.'));
};

const createTextBlock = (text, emptyText = MoodliaCorrectorI18n.t('No detectado')) => {
  const block = document.createElement('div');
  block.className = 'text-block';
  block.textContent = text || emptyText;
  return block;
};

const renderAssignmentSummary = (container, assignmentData) => {
  const fragment = document.createDocumentFragment();

  const addSection = (title, content, options = {}) => {
    const section = document.createElement('details');
    section.className = 'summary-card nested-disclosure';
    section.open = Boolean(options.open);

    const heading = document.createElement('summary');
    heading.textContent = title;
    section.appendChild(heading);

    if (typeof content === 'string') {
      section.appendChild(createTextBlock(content));
    } else {
      section.appendChild(content);
    }

    fragment.appendChild(section);
  };

  const taskList = document.createElement('dl');
  taskList.className = 'compact-list';
  [
    [MoodliaCorrectorI18n.t('Curso'), assignmentData.courseName || MoodliaCorrectorI18n.t('No detectado')],
    [MoodliaCorrectorI18n.t('Tarea'), assignmentData.assignmentTitle || MoodliaCorrectorI18n.t('No detectada')],
    [MoodliaCorrectorI18n.t('Alumno/a'), assignmentData.studentName || MoodliaCorrectorI18n.t('No detectado')],
    [MoodliaCorrectorI18n.t('Corrección'), gradingModeParts(assignmentData).join(' · ')],
    [
      MoodliaCorrectorI18n.t('Descripción'),
      assignmentData.assignmentDescriptionLink?.url
        ? assignmentData.assignmentDescriptionLink.url
        : MoodliaCorrectorI18n.t('No detectada'),
    ],
    [MoodliaCorrectorI18n.t('Puntuación máxima'), assignmentData.maxScore ?? MoodliaCorrectorI18n.t('No detectada')],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = String(value);
    row.append(term, description);
    taskList.appendChild(row);
  });

  addSection(MoodliaCorrectorI18n.t('Contexto de la tarea'), taskList);
  const controlsList = document.createElement('dl');
  controlsList.className = 'compact-list';
  const gradingControls = assignmentData.gradingControls || {};
  [
    [
      MoodliaCorrectorI18n.t('Niveles de rúbrica'),
      assignmentData.rubric.length
        ? MoodliaCorrectorI18n.message`${gradingControls.rubricCriteriaWithLevelControls || 0} de ${assignmentData.rubric.length} criterios se pueden seleccionar`
        : MoodliaCorrectorI18n.t('No se han detectado controles de rúbrica'),
    ],
    [
      MoodliaCorrectorI18n.t('Comentarios por criterio'),
      assignmentData.rubric.length
        ? MoodliaCorrectorI18n.message`${gradingControls.rubricCriteriaWithCommentBoxes || 0} de ${assignmentData.rubric.length} cajas de comentario detectadas`
        : MoodliaCorrectorI18n.t('No se han detectado comentarios por criterio'),
    ],
    [
      MoodliaCorrectorI18n.t('Comentario final'),
      gradingControls.finalFeedback ? MoodliaCorrectorI18n.message`Detectado (${gradingControls.finalFeedbackType})` : MoodliaCorrectorI18n.t('No detectado'),
    ],
    [MoodliaCorrectorI18n.t('Campo de nota'), gradingControls.grade ? MoodliaCorrectorI18n.message`Detectado (${gradingControls.gradeType})` : MoodliaCorrectorI18n.t('No detectado')],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    controlsList.appendChild(row);
  });
  addSection(MoodliaCorrectorI18n.t('Controles de corrección'), controlsList);
  addSection(
    assignmentData.linkedAssignmentDescription?.text ? MoodliaCorrectorI18n.t('Descripción enlazada de la tarea') : MoodliaCorrectorI18n.t('Instrucciones'),
    assignmentData.assignmentPrompt ||
      assignmentData.linkedAssignmentDescription?.error ||
      MoodliaCorrectorI18n.t('No detectado'),
  );
  addSection(MoodliaCorrectorI18n.t('Material de referencia del enunciado (no es trabajo del alumno)'), createAssignmentFileList(assignmentData.assignmentFiles), { open: true });
  addSection(
    MoodliaCorrectorI18n.t('Texto de entrega en línea'),
    assignmentData.submissionText || MoodliaCorrectorI18n.t('No se ha detectado texto de entrega en línea.'),
  );

  const files = document.createElement('ul');
  files.className = 'plain-list';
  if (assignmentData.submissionFiles.length === 0) {
    const item = document.createElement('li');
    item.textContent = MoodliaCorrectorI18n.t('No se han detectado archivos entregados.');
    files.appendChild(item);
  } else {
    for (const file of assignmentData.submissionFiles) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = file.name;
      item.appendChild(link);
      files.appendChild(item);
    }
  }
  addSection(MoodliaCorrectorI18n.t('Archivos entregados'), files);

  const rubric = document.createElement('div');
  rubric.className = 'rubric-list';
  if (assignmentData.rubric.length === 0) {
    rubric.appendChild(createTextBlock('', MoodliaCorrectorI18n.t('No se ha detectado rúbrica.')));
  } else {
    for (const criterion of assignmentData.rubric) {
      const item = document.createElement('details');
      item.className = 'rubric-item';
      const title = document.createElement('summary');
      title.textContent = criterion.description || criterion.id;
      const controls = document.createElement('p');
      controls.textContent = MoodliaCorrectorI18n.message`Niveles: ${criterion.controls?.levelSelection ? MoodliaCorrectorI18n.t('seleccionables') : MoodliaCorrectorI18n.t('no seleccionables')} · Comentario: ${
        criterion.controls?.criterionComment ? MoodliaCorrectorI18n.message`detectado (${criterion.controls.criterionCommentType})` : MoodliaCorrectorI18n.t('no detectado')
      }`;
      const levels = document.createElement('ol');
      levels.className = 'level-list';

      if (criterion.levels.length === 0) {
        const level = document.createElement('li');
        level.textContent = MoodliaCorrectorI18n.t('No se han detectado niveles.');
        levels.appendChild(level);
      } else {
        for (const levelData of criterion.levels) {
          const level = document.createElement('li');
          const status = levelData.selectable ? MoodliaCorrectorI18n.t('seleccionable') : MoodliaCorrectorI18n.t('detectado');
          level.textContent = `${levelData.text || MoodliaCorrectorI18n.message`Nivel ${levelData.index + 1}`} (${status})`;
          levels.appendChild(level);
        }
      }

      item.append(title, controls, levels);
      rubric.appendChild(item);
    }
  }
  addSection(MoodliaCorrectorI18n.t('Rúbrica'), rubric);

  if (assignmentData.gradingGuide?.length > 0) {
    const guide = document.createElement('div');
    guide.className = 'rubric-list';

    for (const criterion of assignmentData.gradingGuide) {
      const item = document.createElement('details');
      item.className = 'rubric-item';
      const title = document.createElement('summary');
      title.textContent = criterion.shortName || criterion.description || criterion.id;
      const score = document.createElement('p');
      score.textContent = criterion.maxScore !== null && criterion.maxScore !== undefined ?MoodliaCorrectorI18n.message`Puntuación máxima: ${criterion.maxScore}` : MoodliaCorrectorI18n.t('No se ha detectado puntuación');
      item.append(title, score);
      guide.appendChild(item);
    }

    addSection(MoodliaCorrectorI18n.t('Guía de evaluación'), guide);
  }

  container.replaceChildren(fragment);
};

const createPanelStyles = () => {
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      --mca-accent: #1f4fa0;
      --mca-accent-strong: #163a78;
      --mca-accent-soft: #eef2f8;
      --mca-ink: #172033;
      --mca-muted: #4a5568;
      --mca-line: #e1e6ed;
      --mca-field: #cdd5df;
      --mca-ground: #f4f6f9;
      --mca-tile: #f7f9fb;
      --mca-ok: #1f8a4c;
      --mca-ok-ink: #14532d;
      --mca-ok-soft: #e8f5ec;
      --mca-warn: #b45309;
      --mca-warn-ink: #6b3500;
      --mca-warn-soft: #fdf3e1;
      color: var(--mca-ink);
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }

    button, select, textarea, input { font: inherit; }
    [hidden] { display: none !important; }
    button:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 2px solid var(--mca-accent);
      outline-offset: 2px;
    }
    button { border: 0; border-radius: 8px; cursor: pointer; color: inherit; background: transparent; }
    svg { display: block; }

    .floating-button {
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 2147483646;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      padding: 0;
      border-radius: 12px;
      background: var(--mca-accent);
      box-shadow: 0 10px 24px rgba(20, 33, 61, 0.22);
    }
    .floating-button svg { width: 32px; height: 32px; }

    .panel {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 2147483645;
      display: grid;
      grid-template-rows: auto 1fr auto;
      width: min(${PANEL_WIDTH}px, 55vw);
      max-width: 100vw;
      height: 100vh;
      background: var(--mca-ground);
      border-left: 1px solid #d5dbe3;
      transform: translateX(100%);
      transition: transform 180ms ease;
    }
    .panel[data-open="true"] { transform: none; }

    /* Header: product, tools, the graded student and the AI in use. */
    .header {
      display: grid;
      gap: 8px;
      padding: 10px 10px 10px 14px;
      background: #fff;
      border-bottom: 1px solid var(--mca-line);
    }
    .header-top { position: relative; display: flex; align-items: center; gap: 8px; }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 26px;
      height: 26px;
    }
    .brand-mark svg { width: 26px; height: 26px; }
    .title { flex-grow: 1; margin: 0; font-size: 14px; font-weight: 700; }
    .panel-tools { display: flex; gap: 2px; }
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      color: var(--mca-muted);
    }
    .icon-button:hover, .icon-button[aria-expanded="true"] { background: var(--mca-accent-soft); color: var(--mca-accent-strong); }
    .icon-button svg { width: 18px; height: 18px; }
    .more-menu {
      position: absolute;
      top: 40px;
      right: 0;
      z-index: 5;
      display: grid;
      min-width: 220px;
      padding: 6px;
      border: 1px solid var(--mca-line);
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 12px 28px rgba(20, 33, 61, 0.16);
    }
    .more-menu button { min-height: 44px; padding: 0 12px; text-align: left; font-weight: 500; }
    .more-menu button:hover { background: var(--mca-accent-soft); }

    /* The graded student on the left, the AI in use on the right. */
    .header-context { display: flex; align-items: center; gap: 10px; }
    .panel-context { flex: 1; min-width: 0; display: grid; }
    .panel-context p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel-context p:empty { display: none; }
    .context-assignment { color: var(--mca-muted); font-size: 12px; }
    .context-student { font-size: 13px; font-weight: 600; }
    .context-student .context-attempt { color: var(--mca-muted); font-weight: 400; }
    .ai-chip {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: 6px;
      max-width: 45%;
      min-height: 30px;
      margin-left: auto;
      padding: 0 10px;
      border-radius: 999px;
      background: var(--mca-tile);
      border: 1px solid var(--mca-line);
      color: var(--mca-ink);
      font-size: 12px;
      font-weight: 600;
    }
    .ai-chip > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-chip:hover, .ai-chip[aria-expanded="true"] { border-color: var(--mca-accent); }
    .ai-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: #8a94a3; }
    .ai-chip[data-state="ok"] { background: var(--mca-ok-soft); border-color: #cbe7d5; color: var(--mca-ok-ink); }
    .ai-chip[data-state="ok"] .ai-dot { background: var(--mca-ok); }
    .ai-chip[data-state="warn"] { background: var(--mca-warn-soft); border-color: #f1d9ae; color: var(--mca-warn-ink); }
    .ai-chip[data-state="warn"] .ai-dot { background: var(--mca-warn); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    /* Content: three collapsible steps, then the technical panes. An open criteria or
       result card takes the free height, so the panel fits without scrolling. */
    .content { display: flex; flex-direction: column; overflow: auto; padding: 10px; }
    .workflow { flex: 1 0 auto; display: flex; flex-direction: column; gap: 8px; }
    .workflow-card {
      display: grid;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--mca-line);
      border-radius: 10px;
      background: #fff;
    }
    .card { display: block; padding: 0; }
    .card > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 0 12px;
      border-radius: 10px;
      list-style: none;
      cursor: pointer;
    }
    .card > summary::-webkit-details-marker { display: none; }
    .card > summary:hover { background: var(--mca-tile); }
    .card > summary h3 { flex: none; margin: 0; font-size: 13px; font-weight: 600; }
    .card-meta { flex: 1 1 0; min-width: 0; overflow: hidden; color: var(--mca-muted); font-size: 12px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .card-meta[data-attention="true"] { color: #b42318; font-weight: 600; }
    .card-chevron { flex: none; display: inline-flex; color: var(--mca-muted); transition: transform 140ms ease; }
    .card-chevron svg { width: 16px; height: 16px; }
    .card[open] > summary .card-chevron { transform: rotate(180deg); }
    .card-body { display: grid; gap: 8px; padding: 0 12px 12px; }
    .card.grow[open] { flex: 1 0 auto; display: flex; flex-direction: column; }
    .card.grow[open]::details-content { flex: 1 0 auto; display: flex; flex-direction: column; }
    .card.grow[open] > .card-body { flex: 1 0 auto; }
    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--mca-accent-soft);
      color: var(--mca-accent-strong);
      font-size: 11px;
      font-weight: 700;
    }
    .hint { margin: 0; color: var(--mca-muted); font-size: 12px; }
    [data-extra-files-summary][data-empty="true"] { display: none; }

    .file-input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
    .add-files {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
      padding: 0 10px;
      border: 1px dashed #b7c2d0;
      border-radius: 7px;
      color: var(--mca-accent);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .add-files:hover { background: var(--mca-accent-soft); }
    .add-files:focus-within { outline: 2px solid var(--mca-accent); outline-offset: 2px; }
    .add-files svg { width: 14px; height: 14px; }

    .instruction-fields { display: flex; flex-direction: column; gap: 8px; }
    .scope-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
      padding: 3px;
      border-radius: 8px;
      background: #eef1f5;
    }
    .scope-tabs button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 30px;
      padding: 0 6px;
      border-radius: 6px;
      color: var(--mca-muted);
      font-weight: 500;
    }
    .scope-tabs button[aria-selected="true"] { background: #fff; color: var(--mca-accent-strong); font-weight: 600; box-shadow: 0 1px 2px rgba(23, 32, 51, 0.12); }
    .scope-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: var(--mca-accent); }
    .scope-tabs button[data-filled="true"] .scope-dot { display: inline-block; }
    .scope-panel { flex: 1 0 auto; display: flex; flex-direction: column; gap: 6px; }
    .instruction-fields textarea {
      flex: 1 0 auto;
      min-height: 72px;
      box-sizing: border-box;
      padding: 8px 10px;
      border-color: var(--mca-field);
      border-radius: 8px;
      font: inherit;
      font-size: 13px;
      white-space: pre-wrap;
      resize: none;
    }

    /* Progress while a correction runs. */
    .progress-card { gap: 14px; }
    .progress-eyebrow { margin: 0; color: var(--mca-accent); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .progress-card h3 { margin: 0; font-size: 18px; font-weight: 700; }
    .progress-bar { height: 8px; border-radius: 999px; background: #e6ebf2; overflow: hidden; }
    .progress-bar > span { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--mca-accent); transition: width 240ms ease; }
    .progress-steps { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .progress-steps li { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; }
    .step-dot {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      box-sizing: border-box;
      border: 2px solid #b7c2d0;
      border-radius: 50%;
    }
    .progress-steps li[data-state="active"] .step-dot { border: 3px solid var(--mca-accent); }
    .progress-steps li[data-state="done"] .step-dot {
      border: 0;
      background: var(--mca-ok) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 13px no-repeat;
    }
    .step-text { display: grid; gap: 2px; }
    .step-title { color: var(--mca-muted); font-weight: 500; font-size: 14px; }
    .progress-steps li[data-state="active"] .step-title { color: var(--mca-accent); font-weight: 600; }
    .progress-steps li[data-state="done"] .step-title { color: var(--mca-ink); font-weight: 600; }
    .step-detail { color: var(--mca-muted); font-size: 12px; overflow-wrap: anywhere; }

    /* Result. */
    [data-result] { display: grid; gap: 10px; overflow-wrap: anywhere; color: #2d3748; }
    [data-result] p { margin: 0; white-space: pre-wrap; }
    .result-score { color: var(--mca-accent); font-size: 22px; font-weight: 700; line-height: 1.2; }
    .result-feedback { font-size: 13px; line-height: 1.55; }
    .result-criterion { padding: 10px 12px; border-radius: 8px; background: var(--mca-tile); font-size: 12px; color: var(--mca-muted); }
    .result-criterion strong { color: var(--mca-ink); font-size: 13px; }
    .result-warning { padding: 10px 12px; border-radius: 8px; background: var(--mca-warn-soft); color: var(--mca-warn-ink); }
    .result-warning-title { margin: 0 0 4px; font-weight: 600; }
    .result-warning ul { margin: 0; padding-left: 18px; white-space: normal; }
    .result-note { color: var(--mca-muted); font-size: 12px; }

    /* Technical panes: AI settings, correction JSON, data and diagnostics. */
    .technical-pane { display: grid; gap: 14px; }
    .pane-header { display: flex; align-items: center; gap: 4px; margin: -6px 0 0 -10px; }
    .pane-header h3 { margin: 0; font-size: 16px; font-weight: 700; }
    .section { display: grid; gap: 8px; }
    .section-title { margin: 0; color: var(--mca-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .field-stack, .runtime-card {
      display: grid;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--mca-line);
      border-radius: 12px;
      background: #fff;
    }
    .field-stack label { color: #2d3748; font-weight: 600; }
    .field-stack textarea.code-input { min-height: 210px; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; white-space: pre; }
    .json-actions { display: grid; gap: 8px; }

    .ai-mode-switch {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px;
      padding: 4px;
      border-radius: 10px;
      background: #eef1f5;
    }
    .ai-mode-switch .action-button { min-height: 36px; border-radius: 7px; background: #fff; color: var(--mca-ink); box-shadow: 0 1px 2px rgba(23, 32, 51, 0.12); }
    .ai-mode-switch .action-button.secondary { background: transparent; color: var(--mca-muted); box-shadow: none; font-weight: 500; }
    .ai-mode-switch .action-button, .ai-mode-switch .action-button.secondary { border: 0; }
    .ai-mode-switch .action-button:hover { background: #fff; color: var(--mca-ink); }
    .ai-mode-switch .action-button.secondary:hover { background: rgba(255, 255, 255, 0.6); color: var(--mca-ink); }
    [data-ai-simple] { display: grid; gap: 12px; }
    .runtime-state { margin: 0; color: var(--mca-muted); font-size: 12px; overflow-wrap: anywhere; }
    .runtime-row { display: grid; gap: 4px; }
    .runtime-row label { color: #2d3748; font-size: 12px; font-weight: 600; }
    .runtime-row input[type="search"], select {
      width: 100%;
      min-width: 0;
      min-height: 40px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--mca-field);
      border-radius: 8px;
      background: #fff;
      color: var(--mca-ink);
    }
    .runtime-cost { margin: 0; color: var(--mca-muted); font-size: 12px; overflow-wrap: anywhere; }
    .runtime-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }

    .action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 40px;
      padding: 0 12px;
      border-radius: 10px;
      background: var(--mca-accent);
      color: #fff;
      font-weight: 600;
    }
    .action-button:hover { background: var(--mca-accent-strong); }
    .action-button.secondary { border: 1px solid var(--mca-field); background: #fff; color: var(--mca-ink); }
    .action-button.secondary:hover { background: var(--mca-tile); }
    .action-button.full-width { width: 100%; }
    .action-button:disabled { cursor: not-allowed; border-color: transparent; background: #8b96a6; color: #f2f4f7; }
    .action-button svg { width: 18px; height: 18px; }

    .diagnostics {
      display: grid;
      gap: 5px;
      max-height: 160px;
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--mca-line);
      border-radius: 8px;
      background: #fff;
      color: #273244;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .diagnostic-entry { padding-bottom: 5px; border-bottom: 1px solid #edf0f5; }
    .detected-list { display: grid; gap: 0; margin: 0; padding: 4px 14px; border: 1px solid var(--mca-line); border-radius: 12px; background: #fff; }
    .detected-list div { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 8px 0; border-bottom: 1px solid #edf0f5; }
    .detected-list div:last-child { border-bottom: 0; }
    .detected-list dt { color: var(--mca-muted); font-weight: 500; }
    .detected-list dd { margin: 0; overflow-wrap: anywhere; }

    /* Assignment summary (Data and diagnostics). */
    .supervision { border: 1px solid var(--mca-line); border-radius: 12px; background: #fff; overflow: hidden; }
    .supervision > summary { display: grid; gap: 2px; padding: 12px 14px; cursor: pointer; font-weight: 600; list-style: none; }
    .supervision > summary::-webkit-details-marker,
    .nested-disclosure > summary::-webkit-details-marker,
    .rubric-item > summary::-webkit-details-marker { display: none; }
    .supervision > summary::after,
    .nested-disclosure > summary::after,
    .rubric-item > summary::after { content: "+"; justify-self: end; margin-top: -20px; color: var(--mca-muted); font-weight: 700; }
    .supervision[open] > summary::after,
    .nested-disclosure[open] > summary::after,
    .rubric-item[open] > summary::after { content: "-"; }
    .supervision-note { margin: 0; color: var(--mca-muted); font-size: 12px; font-weight: 400; }
    .supervision-body { display: grid; gap: 10px; padding: 0 14px 14px; }
    .summary-card { display: grid; gap: 7px; padding: 0; border: 1px solid var(--mca-line); border-radius: 8px; background: #fff; }
    .summary-card > summary, .rubric-item > summary { cursor: pointer; margin: 0; padding: 10px 12px; font-size: 13px; font-weight: 600; }
    .summary-card > :not(summary), .rubric-item > :not(summary) { margin: 0 12px 12px; }
    .text-block { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: #273244; }
    .compact-list { display: grid; gap: 6px; margin: 0; }
    .compact-list div { display: grid; grid-template-columns: 80px 1fr; gap: 8px; }
    .compact-list dt { color: var(--mca-muted); font-weight: 500; }
    .compact-list dd { margin: 0; overflow-wrap: anywhere; }
    .plain-list { display: grid; gap: 5px; margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
    .plain-list a { color: var(--mca-accent); text-decoration: underline; overflow-wrap: anywhere; }
    .rubric-list { display: grid; gap: 8px; }
    .rubric-item { display: grid; gap: 4px; border: 1px solid #e8ecf3; border-radius: 8px; background: var(--mca-tile); }
    .rubric-item p { margin: 0; color: var(--mca-muted); }
    .level-list { display: grid; gap: 5px; margin: 0; padding-left: 18px; }
    .level-list li { color: #273244; overflow-wrap: anywhere; }

    textarea {
      width: 100%;
      min-height: 220px;
      padding: 10px;
      border: 1px solid var(--mca-field);
      border-radius: 8px;
      resize: vertical;
      background: #fff;
      color: var(--mca-ink);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      box-sizing: border-box;
      white-space: pre;
    }

    /* Footer: the one main action. */
    .footer {
      display: grid;
      gap: 6px;
      padding: 10px 12px 12px;
      background: #fff;
      border-top: 1px solid var(--mca-line);
    }
    .footer-status { margin: 0; color: #365075; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
    .footer-actions { display: flex; align-items: center; gap: 10px; }
    .footer-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 32px; color: #2d3748; font-size: 12px; cursor: pointer; }
    .footer-toggle input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--mca-accent); }
    .footer .action-button { flex: none; min-height: 40px; padding: 0 16px; font-size: 13.5px; white-space: nowrap; }
    .footer-note { margin: 0; color: var(--mca-muted); font-size: 11.5px; }
  `;
  return style;
};

const ensurePageLayoutStyle = () => {
  if (document.getElementById(PAGE_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = `
    html.mca-panel-open {
      --mca-panel-width: min(${PANEL_WIDTH}px, 55vw);
      overflow-x: hidden !important;
    }

    html.mca-panel-open body {
      width: calc(100% - var(--mca-panel-width)) !important;
      max-width: calc(100% - var(--mca-panel-width)) !important;
      min-width: 0 !important;
      min-height: 100vh;
      box-sizing: border-box !important;
      transform: translateX(0) !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      overflow-x: auto !important;
    }

    html.mca-panel-open #page,
    html.mca-panel-open #page-wrapper,
    html.mca-panel-open .drawer-toggles,
    html.mca-panel-open [data-region="drawer"] {
      max-width: 100% !important;
    }
  `;
  document.documentElement.appendChild(style);
};

const createFloatingButton = () => {
  if (document.getElementById(FLOATING_BUTTON_ID)) {
    return;
  }

  const host = document.createElement('div');
  host.id = FLOATING_BUTTON_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(createPanelStyles());

  const button = document.createElement('button');
  button.className = 'floating-button';
  button.type = 'button';
  button.title = MoodliaCorrectorI18n.t('Abrir Corrector de Moodle');
  button.setAttribute('aria-label', MoodliaCorrectorI18n.t('Abrir Corrector de Moodle'));
  button.innerHTML = ICON_SVG;
  button.addEventListener('click', openPanel);

  shadow.appendChild(button);
  document.documentElement.appendChild(host);
};

const renderCorrectionResult = (correction) => {
  const container = getPanelElements().result;
  const parsed = correction?.parsed;
  container.replaceChildren();
  if (!parsed) {
    container.textContent = MoodliaCorrectorI18n.t('Aquí verás la nota propuesta y el comentario de la corrección.');
    return;
  }
  setCardLayout('result');
  if (typeof parsed.score === 'number') {
    const score = document.createElement('p');
    score.className = 'result-score';
    score.textContent = MoodliaCorrectorI18n.message`Nota propuesta: ${parsed.score}${parsed.maxScore !== null && parsed.maxScore !== undefined ? ` / ${parsed.maxScore}` : ''}`;
    container.appendChild(score);
  }
  if (typeof parsed.scaleGrade === 'string' && parsed.scaleGrade) {
    const scale = document.createElement('p');
    scale.className = 'result-score';
    scale.textContent = MoodliaCorrectorI18n.message`Nota de escala propuesta: ${parsed.scaleGrade}`;
    container.appendChild(scale);
  }
  const guideScores = Array.isArray(parsed.guideScores) ? parsed.guideScores : [];
  const guideCriteria = guideScores.map(entry => currentAssignmentData?.gradingGuide?.find(item => item.id === entry?.criterionId) || null);
  if (guideScores.length && guideScores.every(entry => Number.isFinite(Number(entry?.score)) && entry?.score !== null)) {
    const total = document.createElement('p');
    total.className = 'result-score';
    const sum = guideScores.reduce((value, entry) => value + Number(entry.score), 0);
    const maximum = guideCriteria.every(criterion => Number.isFinite(Number(criterion?.maxScore)) && criterion?.maxScore !== null)
      ? guideCriteria.reduce((value, criterion) => value + Number(criterion.maxScore), 0) : null;
    total.textContent = MoodliaCorrectorI18n.message`Guía de evaluación: ${Math.round(sum * 100) / 100}${maximum !== null ? ` / ${Math.round(maximum * 100) / 100}` : ''}`;
    container.appendChild(total);
  }
  // Student work that addresses the AI is shown first, as untrusted text.
  if (Array.isArray(correction.evidenceWarnings) && correction.evidenceWarnings.length) {
    const warning = document.createElement('div');
    warning.className = 'result-warning';
    warning.setAttribute('role', 'alert');
    const heading = document.createElement('p');
    heading.className = 'result-warning-title';
    heading.textContent = MoodliaCorrectorI18n.t('La entrega contiene texto dirigido a la IA; revisa la nota con cuidado:');
    const list = document.createElement('ul');
    for (const item of correction.evidenceWarnings.slice(0, 10)) {
      const entry = document.createElement('li');
      const source = String(item?.source || '').slice(0, 200);
      const excerpt = String(item?.excerpt || '').slice(0, 300);
      entry.textContent = source ? `${source === 'online text' ? MoodliaCorrectorI18n.t('texto en línea') : source}: «${excerpt}»` : `«${excerpt}»`;
      list.appendChild(entry);
    }
    warning.append(heading, list);
    container.prepend(warning);
  }
  const feedback = document.createElement('p');
  feedback.className = 'result-feedback';
  feedback.textContent = getFinalComment(parsed) || MoodliaCorrectorI18n.t('Sin comentario final.');
  container.appendChild(feedback);
  // Criterion name in bold, then its comment; the text reads "name: comment" as before.
  const appendCriterion = (name, text) => {
    const paragraph = document.createElement('p');
    paragraph.className = 'result-criterion';
    const title = document.createElement('strong');
    title.textContent = name;
    paragraph.append(title, `: ${text}`);
    container.appendChild(paragraph);
  };
  for (const [index, criterion] of (parsed.rubricSelections || []).entries()) {
    // Match by identity: selections can arrive in a different order than the rubric.
    const rubricCriterion = currentAssignmentData?.rubric?.find(item => item.id === criterion.criterionId);
    appendCriterion(rubricCriterion?.description || MoodliaCorrectorI18n.message`Criterio ${index + 1}`, criterion.criterionFeedback || '');
  }
  for (const [index, entry] of guideScores.entries()) {
    const criterion = guideCriteria[index];
    const name = criterion?.shortName || criterion?.description || MoodliaCorrectorI18n.message`Criterio ${index + 1}`;
    appendCriterion(`${name} (${entry?.score ?? '?'}${criterion?.maxScore !== null && criterion?.maxScore !== undefined ? ` / ${criterion.maxScore}` : ''})`, entry?.remark || '');
  }
  if (Number(correction.pseudonymized?.replacements) > 0) {
    const note = document.createElement('p');
    note.className = 'result-note';
    note.textContent = MoodliaCorrectorI18n.message`El nombre del alumno/a se ha sustituido en lo enviado a la IA (${Number(correction.pseudonymized.replacements)} apariciones).`;
    container.appendChild(note);
  }
};

const showCorrectionPlan = (text) => {
  const note = document.createElement('p');
  note.className = 'result-note';
  note.dataset.correctionPlan = 'true';
  note.textContent = text;
  getPanelElements().result.replaceChildren(note);
};

const PANEL_ICONS = {
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  spark: '<path d="m12 3 1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
const panelIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PANEL_ICONS[name]}</svg>`;
const CRITERIA_SCOPES = ['course', 'assignment', 'case'];

const setMoreMenuOpen = (panel, open) => {
  panel.querySelector('[data-more-menu]').hidden = !open;
  panel.querySelector('[data-more]').setAttribute('aria-expanded', String(open));
};

const showPanelTool = (panel, selected = '', restoreFocus = false) => {
  const previous = panel.dataset.activeTool || '';
  panel.dataset.activeTool = selected;
  setMoreMenuOpen(panel, false);
  panel.querySelector('[data-main-workflow]').hidden = Boolean(selected);
  for (const pane of panel.querySelectorAll('[data-tool-pane]')) pane.hidden = pane.dataset.toolPane !== selected;
  for (const button of panel.querySelectorAll('[data-tool]')) button.setAttribute('aria-expanded', String(button.dataset.tool === selected));
  panel.querySelector('.content').scrollTop = 0;
  if (selected) panel.querySelector(`[data-tool-pane="${selected}"] h3`).focus();
  // Tools in the closed "More options" menu return focus to the menu button.
  else if (restoreFocus && previous) (previous === 'settings' ? panel.querySelector('[data-tool="settings"]') : panel.querySelector('[data-more]')).focus();
};

// One criterion field is visible at a time; a dot marks the scopes that hold text.
const selectCriteriaScope = (panel, scope, focusTab = false) => {
  for (const tab of panel.querySelectorAll('[data-scope-tab]')) {
    const selected = tab.dataset.scopeTab === scope;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  }
  for (const pane of panel.querySelectorAll('[data-scope-panel]')) pane.hidden = pane.dataset.scopePanel !== scope;
};
const updateCriteriaTabs = () => {
  const { panel } = getPanelElements();
  for (const tab of panel.querySelectorAll('[data-scope-tab]')) {
    const field = panel.querySelector(`[data-scope-panel="${tab.dataset.scopeTab}"] textarea`);
    tab.dataset.filled = String(Boolean(field?.value.trim()));
  }
};

const setPanelContext = (assignmentData) => {
  const { panel } = getPanelElements();
  const assignment = panel.querySelector('[data-context-assignment]');
  const student = panel.querySelector('[data-context-student]');
  assignment.textContent = assignmentData ? [assignmentData.assignmentTitle, assignmentData.courseName].filter(Boolean).join(' · ') : '';
  student.replaceChildren();
  if (assignmentData?.studentName) {
    const attempt = document.createElement('span');
    attempt.className = 'context-attempt';
    attempt.textContent = ` · ${MoodliaCorrectorI18n.message`Intento ${Number(getGradedAttemptNumber()) + 1}`}`;
    student.append(assignmentData.studentName, attempt);
  }
};

// The step cards open by moment: the criteria before correcting (with the evidence when a
// file needs attention), the result while and after correcting. The teacher can open or close
// any card at any time; the next moment applies its own layout again.
const setCardLayout = (layout) => {
  const { panel } = getPanelElements();
  const card = (name) => panel.querySelector(`[data-card="${name}"]`);
  const attention = panel.querySelector('[data-evidence-summary]').dataset.attention === 'true';
  card('evidence').open = layout === 'start' && attention;
  card('criteria').open = layout === 'start';
  card('result').open = layout !== 'start';
};

// Correction progress: four stages fed by the service worker's progress events.
const PROGRESS_STEPS = ['read', 'review', 'grade', 'apply'];
const PROGRESS_STAGE_STEP = { download: 'read', read: 'read', plan: 'review', model: 'review', review: 'review', grade: 'grade', repair: 'grade' };
const showCorrectionProgress = (visible) => {
  const { panel } = getPanelElements();
  const card = panel.querySelector('[data-progress]');
  card.hidden = !visible;
  if (visible) panel.dataset.correcting = 'true';
  else delete panel.dataset.correcting;
  if (!visible) return;
  setCardLayout('running');
  for (const step of card.querySelectorAll('[data-progress-step]')) {
    step.dataset.state = 'pending';
    step.querySelector('.step-detail').textContent = '';
  }
  updateCorrectionProgress({ stage: 'download' }, MoodliaCorrectorI18n.t('Solicitando corrección a la IA...'));
};
const updateCorrectionProgress = (progress, status) => {
  const { panel } = getPanelElements();
  const card = panel.querySelector('[data-progress]');
  const stepId = progress.stage === 'apply' ? 'apply' : PROGRESS_STAGE_STEP[progress.stage];
  if (!stepId) return;
  const index = PROGRESS_STEPS.indexOf(stepId);
  for (const [position, step] of [...card.querySelectorAll('[data-progress-step]')].entries()) {
    step.dataset.state = position < index ? 'done' : position === index ? 'active' : 'pending';
    if (position === index && status) step.querySelector('.step-detail').textContent = status;
  }
  card.querySelector('[data-progress-title]').textContent = card.querySelector(`[data-progress-step="${stepId}"] .step-title`).textContent;
  const fraction = Number(progress.total) > 0 ? Math.min(1, Number(progress.current) / Number(progress.total)) : 0.3;
  const percent = Math.round(((index + fraction) / PROGRESS_STEPS.length) * 100);
  card.querySelector('[data-progress-fill]').style.width = `${percent}%`;
  card.querySelector('[data-progress-bar]').setAttribute('aria-valuenow', String(percent));
};

const updateAiChip = () => {
  const { panel } = getPanelElements();
  const chip = panel.querySelector('[data-tool="settings"]');
  const label = chip.querySelector('[data-ai-chip-label]');
  const config = aiRuntimeStatus?.appConfig;
  const ready = Boolean(aiRuntimeStatus?.providers?.length && config?.configured && !config?.reason);
  chip.dataset.state = !aiRuntimeStatus ? 'unknown' : ready ? 'ok' : 'warn';
  label.textContent = ready && config?.model ? config.model : MoodliaCorrectorI18n.t('Configurar IA');
};

const createSidePanel = () => {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    return existing;
  }

  const host = document.createElement('div');
  host.id = PANEL_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(createPanelStyles());

  const panel = document.createElement('aside');
  panel.className = 'panel';
  panel.dataset.open = 'false';
  panel.innerHTML = `
    <header class="header">
      <div class="header-top">
        <span class="brand-mark" aria-hidden="true">${ICON_SVG}</span>
        <h2 class="title">MoodlIA Corrector</h2>
        <nav class="panel-tools" aria-label="Herramientas del corrector">
          <button class="icon-button" type="button" data-more aria-label="Más opciones" title="Más opciones" aria-expanded="false" aria-controls="mca-more-menu">${panelIcon('more')}</button>
          <button class="icon-button" type="button" data-close aria-label="Cerrar" title="Cerrar">${panelIcon('close')}</button>
        </nav>
        <div class="more-menu" id="mca-more-menu" data-more-menu hidden>
          <button type="button" data-tool="json" aria-controls="mca-tool-json" aria-expanded="false">JSON de corrección</button>
          <button type="button" data-tool="inspect" aria-controls="mca-tool-inspect" aria-expanded="false">Datos y diagnóstico</button>
        </div>
      </div>
      <div class="header-context">
        <div class="panel-context">
          <p class="context-assignment" data-context-assignment></p>
          <p class="context-student" data-context-student></p>
        </div>
        <button class="ai-chip" type="button" data-tool="settings" data-state="unknown" aria-controls="mca-tool-settings" aria-expanded="false" title="Configuración de IA"><span class="ai-dot" aria-hidden="true"></span><span data-ai-chip-label>Configurar IA</span></button>
      </div>
    </header>
    <div class="content">
      <div class="workflow" data-main-workflow>
        <section class="workflow-card progress-card" data-progress aria-live="polite" hidden>
          <p class="progress-eyebrow">Corrigiendo</p>
          <h3 data-progress-title></h3>
          <div class="progress-bar" data-progress-bar role="progressbar" aria-label="Progreso de la corrección" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-progress-fill></span></div>
          <ol class="progress-steps">
            <li data-progress-step="read"><span class="step-dot" aria-hidden="true"></span><span class="step-text"><span class="step-title">Leer los archivos</span><span class="step-detail"></span></span></li>
            <li data-progress-step="review"><span class="step-dot" aria-hidden="true"></span><span class="step-text"><span class="step-title">Revisar las evidencias</span><span class="step-detail"></span></span></li>
            <li data-progress-step="grade"><span class="step-dot" aria-hidden="true"></span><span class="step-text"><span class="step-title">Redactar la nota y el comentario</span><span class="step-detail"></span></span></li>
            <li data-progress-step="apply"><span class="step-dot" aria-hidden="true"></span><span class="step-text"><span class="step-title">Rellenar el formulario de Moodle</span><span class="step-detail"></span></span></li>
          </ol>
        </section>
        <details class="workflow-card card" data-card="evidence">
          <summary><span class="step-number" aria-hidden="true">1</span><h3>Evidencias para la IA</h3><span class="card-meta" data-evidence-summary></span><span class="card-chevron">${panelIcon('chevron')}</span></summary>
          <div class="card-body">
            <div data-file-preview></div>
            <label class="add-files" data-add-files title="Hasta 20 MB por archivo y 40 MB en total.">${panelIcon('add')}<span>Añadir archivos de apoyo</span><input class="file-input" id="mca-extra-files" data-extra-files type="file" multiple /></label>
            <p class="hint" data-extra-files-summary>Sin archivos adicionales.</p>
          </div>
        </details>
        <details class="workflow-card card grow" data-card="criteria" open>
          <summary><span class="step-number" aria-hidden="true">2</span><h3>Criterio docente</h3><span class="card-meta">Se guarda automáticamente.</span><span class="card-chevron">${panelIcon('chevron')}</span></summary>
          <div class="card-body instruction-fields">
            <div class="scope-tabs" role="tablist" aria-label="Ámbito del criterio">
              <button type="button" role="tab" id="mca-tab-course" data-scope-tab="course" aria-controls="mca-scope-course" aria-selected="false" tabindex="-1" title="Para todas las tareas de este curso."><span>Curso</span><span class="scope-dot" aria-hidden="true"></span></button>
              <button type="button" role="tab" id="mca-tab-assignment" data-scope-tab="assignment" aria-controls="mca-scope-assignment" aria-selected="true" title="Para todos los alumnos de esta tarea."><span>Tarea</span><span class="scope-dot" aria-hidden="true"></span></button>
              <button type="button" role="tab" id="mca-tab-case" data-scope-tab="case" aria-controls="mca-scope-case" aria-selected="false" tabindex="-1" title="Solo para este alumno e intento de esta tarea."><span>Este alumno</span><span class="scope-dot" aria-hidden="true"></span></button>
            </div>
            <div class="scope-panel" role="tabpanel" id="mca-scope-course" data-scope-panel="course" aria-labelledby="mca-tab-course" hidden>
              <label class="sr-only" for="mca-course-instructions">Por curso</label>
              <textarea id="mca-course-instructions" data-course-instructions placeholder="Criterios generales del curso..."></textarea>
            </div>
            <div class="scope-panel" role="tabpanel" id="mca-scope-assignment" data-scope-panel="assignment" aria-labelledby="mca-tab-assignment">
              <label class="sr-only" for="mca-assignment-instructions">Por tarea</label>
              <textarea id="mca-assignment-instructions" data-assignment-instructions placeholder="Qué valorar en esta tarea..."></textarea>
              <button class="action-button secondary" type="button" data-recover-instructions hidden>Copiar instrucciones anteriores a esta tarea</button>
            </div>
            <div class="scope-panel" role="tabpanel" id="mca-scope-case" data-scope-panel="case" aria-labelledby="mca-tab-case" hidden>
              <label class="sr-only" for="mca-extra-instructions">Por caso concreto</label>
              <textarea id="mca-extra-instructions" data-extra-instructions placeholder="Ej.: valora especialmente la claridad de las actividades, penaliza si no hay evidencias del uso de IA..."></textarea>
            </div>
          </div>
        </details>
        <details class="workflow-card card grow" data-card="result">
          <summary><span class="step-number" aria-hidden="true">3</span><h3>Resultado</h3><span class="card-meta" data-grading-mode>Modo: pendiente de detectar</span><span class="card-chevron">${panelIcon('chevron')}</span></summary>
          <div class="card-body"><div data-result aria-live="polite">Aquí verás la nota propuesta y el comentario de la corrección.</div></div>
        </details>
      </div>
      <section class="technical-pane" id="mca-tool-settings" data-tool-pane="settings" aria-labelledby="mca-tool-title-settings" hidden>
        <div class="pane-header"><button class="icon-button" type="button" data-tool-back aria-label="Volver a la corrección" title="Volver a la corrección">${panelIcon('back')}</button><h3 id="mca-tool-title-settings" tabindex="-1">Configuración de IA</h3></div>
        <div class="runtime-card">
          <div class="ai-mode-switch" role="group" aria-label="Modo de configuración de IA">
            <button class="action-button" type="button" data-ai-mode="simple" aria-pressed="true">Simple</button>
            <button class="action-button secondary" type="button" data-ai-mode="advanced" aria-pressed="false">Avanzado</button>
          </div>
          <p class="runtime-state" data-runtime-state role="status" aria-live="polite">Comprobando la IA...</p>
          <div data-ai-simple>
            <div class="runtime-row">
              <label for="mca-provider">Proveedor</label>
              <select id="mca-provider" data-provider></select>
            </div>
            <div class="runtime-row">
              <label for="mca-model-search">Buscar modelos</label>
              <input id="mca-model-search" data-model-search type="search" placeholder="Nombre, parámetros o cuantización" aria-controls="mca-model" />
            </div>
            <div class="runtime-row">
              <label for="mca-model">Modelo</label>
              <select id="mca-model" data-model></select>
            </div>
            <p class="runtime-cost" data-runtime-cost hidden></p>
            <div class="runtime-actions">
              <button class="action-button secondary" type="button" data-runtime-refresh>Actualizar IA</button>
              <button class="action-button secondary" type="button" data-runtime-options>Probar conexión</button>
            </div>
          </div>
          <div data-ai-advanced hidden></div>
        </div>
      </section>
      <section class="technical-pane" id="mca-tool-json" data-tool-pane="json" aria-labelledby="mca-tool-title-json" hidden>
        <div class="pane-header"><button class="icon-button" type="button" data-tool-back aria-label="Volver a la corrección" title="Volver a la corrección">${panelIcon('back')}</button><h3 id="mca-tool-title-json" tabindex="-1">JSON de corrección</h3></div>
        <section class="section">
          <h4 class="section-title">JSON externo</h4>
          <div class="field-stack">
            <label for="mca-correction-json">JSON de corrección</label>
            <textarea id="mca-correction-json" class="code-input" data-external-correction spellcheck="false" placeholder='{"finalComment":"Comentario final...","score":null,"maxScore":null,"rubricSelections":[{"criterionNumber":1,"levelIndex":3,"criterionFeedback":"Comentario del criterio..."}]}'></textarea>
            <p class="hint">Formato recomendado: finalComment y rubricSelections con criterionNumber, levelIndex y criterionFeedback. No hace falta conocer los ids de Moodle.</p>
            <div class="json-actions">
              <button class="action-button full-width" type="button" data-apply-correction>Aplicar JSON a Moodle</button>
            </div>
          </div>
        </section>
        <section class="section">
          <h4 class="section-title">Sugerencia de IA</h4>
          <textarea data-correction spellcheck="false" aria-label="JSON de la sugerencia de IA"></textarea>
        </section>
      </section>
      <section class="technical-pane" id="mca-tool-inspect" data-tool-pane="inspect" aria-labelledby="mca-tool-title-inspect" hidden>
        <div class="pane-header"><button class="icon-button" type="button" data-tool-back aria-label="Volver a la corrección" title="Volver a la corrección">${panelIcon('back')}</button><h3 id="mca-tool-title-inspect" tabindex="-1">Datos y diagnóstico</h3></div>
        <section class="section">
          <h4 class="section-title">Detectado</h4>
          <dl class="detected-list" data-detected-list></dl>
        </section>
        <section class="section">
          <h4 class="section-title">Información usada para corregir</h4>
          <div data-assignment></div>
        </section>
        <section class="section">
          <h4 class="section-title">Diagnóstico</h4>
          <div class="diagnostics" data-diagnostics></div>
        </section>
      </section>
    </div>
    <footer class="footer">
      <p class="footer-status" data-status role="status" aria-live="polite">Listo.</p>
      <div class="footer-actions">
        <label class="footer-toggle"><input type="checkbox" data-auto-correct><span>Corregir al pasar al siguiente alumno</span></label>
        <button class="action-button" type="button" data-correct>${panelIcon('spark')}<span>Corregir con IA</span></button>
        <button class="action-button secondary" type="button" data-cancel-correction hidden style="display:none">Cancelar</button>
      </div>
      <p class="footer-note">Revisa antes de guardar. La extensión no envía el formulario.</p>
    </footer>
  `;

  MoodliaCorrectorI18n.localize(panel);

  panel.querySelector('[data-close]').addEventListener('click', closePanel);
  panel.querySelector('[data-more]').addEventListener('click', () => {
    const open = panel.querySelector('[data-more-menu]').hidden;
    setMoreMenuOpen(panel, open);
    if (open) panel.querySelector('[data-more-menu] button').focus();
  });
  for (const button of panel.querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => showPanelTool(panel, panel.dataset.activeTool === button.dataset.tool ? '' : button.dataset.tool));
  }
  for (const button of panel.querySelectorAll('[data-tool-back]')) button.addEventListener('click', () => showPanelTool(panel, '', true));
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!panel.querySelector('[data-more-menu]').hidden) {
      event.preventDefault();
      event.stopPropagation();
      setMoreMenuOpen(panel, false);
      panel.querySelector('[data-more]').focus();
    } else if (panel.dataset.activeTool) {
      event.preventDefault();
      event.stopPropagation();
      showPanelTool(panel, '', true);
    }
  });
  panel.addEventListener('click', (event) => {
    if (!event.composedPath().some(node => node?.dataset && ('more' in node.dataset || 'moreMenu' in node.dataset))) setMoreMenuOpen(panel, false);
  });

  const tabs = [...panel.querySelectorAll('[data-scope-tab]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectCriteriaScope(panel, tab.dataset.scopeTab));
    tab.addEventListener('keydown', (event) => {
      const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!offset) return;
      event.preventDefault();
      const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
      selectCriteriaScope(panel, next.dataset.scopeTab, true);
    });
  }
  for (const field of panel.querySelectorAll('.scope-panel textarea')) field.addEventListener('input', updateCriteriaTabs);

  panel.querySelector('[data-correct]').addEventListener('click', () => void requestCorrectionFromPanel().catch(error => setPanelStatus(error.message || String(error))));
  panel.querySelector('[data-cancel-correction]').addEventListener('click', () => void cancelCorrectionFromPage().catch((error) => setPanelStatus(error.message)));
  const autoCorrect = panel.querySelector('[data-auto-correct]');
  void chrome.storage.local.get(AUTO_CORRECT_STORAGE_KEY).then(stored => { autoCorrect.checked = stored[AUTO_CORRECT_STORAGE_KEY] === true; }).catch(() => {});
  autoCorrect.addEventListener('change', () => void chrome.storage.local.set({ [AUTO_CORRECT_STORAGE_KEY]: autoCorrect.checked }).catch(() => {}));
  panel.querySelector('[data-apply-correction]').addEventListener('click', () => {
    void applyCorrectionFromPanel().catch(error => { setPanelStatus(error.message || String(error)); addPanelDiagnostic('manualCorrection.error', { message: error.message || String(error) }); });
  });
  panel.querySelector('[data-runtime-refresh]').addEventListener('click', () => void refreshAiRuntimeStatus());
  panel.querySelector('[data-runtime-options]').addEventListener('click', () => void testPanelAiConnection());
  for (const button of panel.querySelectorAll('[data-ai-mode]')) button.addEventListener('click', () => void setAiSettingsMode(button.dataset.aiMode).catch(error => setPanelStatus(error.message)));
  panel.querySelector('[data-provider]').addEventListener('change', () => void saveAiRuntimeSelection(true));
  panel.querySelector('[data-model-search]').addEventListener('input', () => renderAiRuntimeControls());
  panel.querySelector('[data-model]').addEventListener('change', () => void saveAiRuntimeSelection(false));
  panel.querySelector('[data-extra-files]').addEventListener('change', () => {
    if (currentCorrection) currentCorrection.skippedFiles = (currentCorrection.skippedFiles || []).filter(file => file.role !== 'teacher-additional');
    updateExtraFilesSummary();
  });

  shadow.appendChild(panel);
  document.documentElement.appendChild(host);
  return host;
};

const getPanelElements = () => {
  const host = createSidePanel();
  const root = host.shadowRoot;
  return {
    panel: root.querySelector('.panel'),
    status: root.querySelector('[data-status]'),
    gradingMode: root.querySelector('[data-grading-mode]'),
    detectedList: root.querySelector('[data-detected-list]'),
    assignment: root.querySelector('[data-assignment]'),
    externalCorrection: root.querySelector('[data-external-correction]'),
    correction: root.querySelector('[data-correction]'),
    result: root.querySelector('[data-result]'),
    correctButton: root.querySelector('[data-correct]'),
    cancelButton: root.querySelector('[data-cancel-correction]'),
    applyCorrectionButton: root.querySelector('[data-apply-correction]'),
    extraInstructions: root.querySelector('[data-extra-instructions]'),
    courseInstructions: root.querySelector('[data-course-instructions]'),
    assignmentInstructions: root.querySelector('[data-assignment-instructions]'),
    recoverInstructions: root.querySelector('[data-recover-instructions]'),
    extraFiles: root.querySelector('[data-extra-files]'),
    extraFilesSummary: root.querySelector('[data-extra-files-summary]'),
    filePreview: root.querySelector('[data-file-preview]'),
    addFiles: root.querySelector('[data-add-files]'),
    evidenceSummary: root.querySelector('[data-evidence-summary]'),
    provider: root.querySelector('[data-provider]'),
    model: root.querySelector('[data-model]'),
    runtimeState: root.querySelector('[data-runtime-state]'),
    runtimeCost: root.querySelector('[data-runtime-cost]'),
    diagnostics: root.querySelector('[data-diagnostics]'),
  };
};

const setPanelStatus = (message) => {
  getPanelElements().status.textContent = MoodliaCorrectorI18n.t(message);
};

const addPanelDiagnostic = (stage, detail = {}) => {
  const { diagnostics } = getPanelElements();
  const entry = document.createElement('div');
  entry.className = 'diagnostic-entry';
  entry.textContent = `${new Date().toLocaleTimeString()} ${stage} ${JSON.stringify(detail)}`;
  diagnostics.prepend(entry);

  while (diagnostics.children.length > 20) {
    diagnostics.lastElementChild?.remove();
  }
};

const updateExtraFilesSummary = () => {
  const { panel, extraFiles, extraFilesSummary, filePreview, addFiles, evidenceSummary } = getPanelElements();
  const files = [...(extraFiles?.files || [])];
  const preview = MoodliaCorrectorFilePreview.render(filePreview, currentAssignmentData, files, currentCorrection?.skippedFiles || [], { addControl: addFiles });
  evidenceSummary.textContent = currentAssignmentData || files.length
    ? [MoodliaCorrectorI18n.message`${preview.included} incluido(s)`, ...(preview.skipped ? [MoodliaCorrectorI18n.message` · ${preview.skipped} omitido(s)`] : [])].join('')
    : '';
  evidenceSummary.dataset.attention = String(preview.attention);
  // Skipped files or no evidence at all: show the evidence card unless a result is on screen.
  if (preview.attention && !currentCorrection?.parsed && !panel.dataset.correcting) panel.querySelector('[data-card="evidence"]').open = true;
  extraFilesSummary.dataset.empty = String(files.length === 0);

  if (files.length === 0) {
    extraFilesSummary.textContent = MoodliaCorrectorI18n.t('Sin archivos adicionales.');
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const { MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } = MoodliaCorrectorAttachmentSupport;
  const oversized = files.some(file => file.size > MAX_ATTACHMENT_BYTES) || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES;
  extraFilesSummary.textContent = [
    MoodliaCorrectorI18n.message`${files.length} archivo(s) adicional(es), ${(totalBytes / 1024 / 1024).toFixed(2)} MB.`,
    ...(oversized ? [MoodliaCorrectorI18n.t('Superan el límite de 20 MB por archivo o 40 MB en total: quita alguno antes de corregir.')] : []),
  ].join(' ');
};

const readExtraFilesFromPanel = async () => {
  const { extraFiles } = getPanelElements();
  const attachments = await MoodliaCorrectorAttachmentSupport.readSelectedFiles(extraFiles?.files || []);
  updateExtraFilesSummary();
  return attachments;
};

const buildPanelAssignmentData = async () => {
  await savedInstructionsReady;
  const teacherCriteria = await instructionsController.getValues();
  const extraFiles = await readExtraFilesFromPanel();

  return {
    ...currentAssignmentData,
    teacherCriteria,
    extraInstructions: Object.values(teacherCriteria).filter(Boolean).join('\n\n'),
    extraFiles,
  };
};

const refreshDiagnostics = async () => {
  try {
    const response = await sendBackgroundMessage({ type: 'mca.getDiagnostics' });
    if (!response?.ok) {
      return;
    }

    const { diagnostics } = getPanelElements();
    diagnostics.replaceChildren(
      ...response.diagnostics.slice(0, 20).map((item) => {
        const entry = document.createElement('div');
        entry.className = 'diagnostic-entry';
        entry.textContent = `${new Date(item.time).toLocaleTimeString()} ${item.stage} ${JSON.stringify(item.detail)}`;
        return entry;
      }),
    );
  } catch {
    // Diagnostics should never block correction.
  }
};

const setPageShift = (enabled) => {
  if (!document.body) {
    return;
  }

  if (enabled) {
    ensurePageLayoutStyle();
    originalPageStyles = originalPageStyles || {
      htmlClass: document.documentElement.className,
      bodyWidth: document.body.style.width,
      bodyMaxWidth: document.body.style.maxWidth,
      bodyTransition: document.body.style.transition,
    };
    document.body.style.transition = 'width 180ms ease, max-width 180ms ease';
    document.documentElement.classList.add('mca-panel-open');
    return;
  }

  document.documentElement.classList.remove('mca-panel-open');
  if (originalPageStyles) {
    document.body.style.width = originalPageStyles.bodyWidth;
    document.body.style.maxWidth = originalPageStyles.bodyMaxWidth;
    document.body.style.transition = originalPageStyles.bodyTransition;
    originalPageStyles = null;
  }
};

const openPanel = () => {
  const { panel } = getPanelElements();
  // Catch up with any navigation that happened while the panel was closed.
  navigationWatcher?.check();
  panel.dataset.open = 'true';
  navigationWatcher?.observe();
  setPageShift(true);
  addPanelDiagnostic('panel.open');
  const revision = gradingPageRevision;
  void refreshPanelData().catch((error) => {
    if (revision === gradingPageRevision) setPanelStatus(error.message);
  });
  void refreshAiRuntimeStatus();
  void refreshDiagnostics();
};

const closePanel = () => {
  const { panel } = getPanelElements();
  panel.dataset.open = 'false';
  navigationWatcher?.pause();
  setPageShift(false);
};

const updateDetectedList = (assignmentData) => {
  const { detectedList, gradingMode } = getPanelElements();
  gradingMode.textContent = describeGradingMode(assignmentData);
  setPanelContext(assignmentData);
  const gradingControls = assignmentData.gradingControls || {};
  const entries = [
    [MoodliaCorrectorI18n.t('Tarea Moodle'), assignmentData.page.detectedAsMoodleAssignment ? MoodliaCorrectorI18n.t('Sí') : MoodliaCorrectorI18n.t('No')],
    [MoodliaCorrectorI18n.t('Título'), assignmentData.assignmentTitle || MoodliaCorrectorI18n.t('No detectado')],
    [
      MoodliaCorrectorI18n.t('Descripción'),
      assignmentData.assignmentDescriptionLink?.url
        ? assignmentData.linkedAssignmentDescription?.text
          ? MoodliaCorrectorI18n.t('Enlace y contenido recuperados')
          : MoodliaCorrectorI18n.t('Enlace detectado')
        : MoodliaCorrectorI18n.t('No detectada'),
    ],
    [MoodliaCorrectorI18n.t('Instrucciones'), assignmentData.assignmentPrompt ? MoodliaCorrectorI18n.message`${assignmentData.assignmentPrompt.length} caracteres` : MoodliaCorrectorI18n.t('No detectadas')],
    [MoodliaCorrectorI18n.t('Texto en línea'), assignmentData.submissionText ? MoodliaCorrectorI18n.message`${assignmentData.submissionText.length} caracteres` : MoodliaCorrectorI18n.t('No detectado')],
    [MoodliaCorrectorI18n.t('Archivos entregados'), MoodliaCorrectorI18n.message`${assignmentData.submissionFiles.length} archivo(s)`],
    [MoodliaCorrectorI18n.t('Archivos del enunciado'), MoodliaCorrectorI18n.message`${assignmentData.assignmentFiles?.length || 0} archivo(s)`],
    [MoodliaCorrectorI18n.t('Rúbrica'), MoodliaCorrectorI18n.message`${assignmentData.rubric.length} criterio(s)`],
    [
      MoodliaCorrectorI18n.t('Controles de rúbrica'),
      assignmentData.rubric.length
        ? MoodliaCorrectorI18n.message`${gradingControls.rubricCriteriaWithLevelControls || 0}/${assignmentData.rubric.length} controles de nivel, ${gradingControls.rubricCriteriaWithCommentBoxes || 0}/${assignmentData.rubric.length} comentarios`
        : MoodliaCorrectorI18n.t('No detectados'),
    ],
    [
      MoodliaCorrectorI18n.t('Comentario final'),
      gradingControls.finalFeedback
        ? MoodliaCorrectorI18n.message`Detectado (${gradingControls.finalFeedbackType})`
        : MoodliaCorrectorI18n.t('No detectado'),
    ],
    [MoodliaCorrectorI18n.t('Guía'), MoodliaCorrectorI18n.message`${assignmentData.gradingGuide.length} criterio(s)`],
    [MoodliaCorrectorI18n.t('Puntuación máxima'), assignmentData.maxScore ?? MoodliaCorrectorI18n.t('No detectada')],
  ];

  detectedList.replaceChildren(
    ...entries.map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = String(value);
      row.append(term, description);
      return row;
    }),
  );
};

const refreshPanelData = async () => {
  const revision = gradingPageRevision;
  setPanelStatus(MoodliaCorrectorI18n.t('Detectando datos de Moodle...'));
  addPanelDiagnostic('extract.start');
  const gradingPanelReady = await waitForGradingPanelReady();
  addPanelDiagnostic('extract.gradePanelReady', { ready: gradingPanelReady });
  let assignmentData;
  try {
    assignmentData = await extractAssignmentData();
  } catch (error) {
    if (revision !== gradingPageRevision) return;
    throw error;
  }
  if (revision !== gradingPageRevision) return;
  currentAssignmentData = assignmentData;
  savedInstructionsReady = instructionsController.setContext(assignmentData.instructionContext);

  const { assignment, correction } = getPanelElements();
  updateDetectedList(currentAssignmentData);
  updateExtraFilesSummary();
  renderAssignmentSummary(assignment, currentAssignmentData);

  if (!currentCorrection) {
    correction.value = '';
  }

  setPanelStatus(MoodliaCorrectorI18n.t('Datos detectados listos.'));
  addPanelDiagnostic('extract.done', {
    files: currentAssignmentData.submissionFiles.length,
    rubricCriteria: currentAssignmentData.rubric.length,
    rubricLevelControls: currentAssignmentData.gradingControls.rubricCriteriaWithLevelControls,
    rubricCommentBoxes: currentAssignmentData.gradingControls.rubricCriteriaWithCommentBoxes,
    finalFeedback: currentAssignmentData.gradingControls.finalFeedback,
    guideCriteria: currentAssignmentData.gradingGuide.length,
    guideScoreInputs: currentAssignmentData.gradingControls.guideCriteriaWithScoreInputs,
    scaleOptions: currentAssignmentData.gradeScaleOptions?.length || 0,
    onlineText: Boolean(currentAssignmentData.submissionText),
  });
};

const getFirstTextValue = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const getModelId = (modelInfo) => {
  if (typeof modelInfo === 'string') {
    return modelInfo;
  }

  return getFirstTextValue(modelInfo?.id, modelInfo?.model, modelInfo?.name, modelInfo?.value);
};

const getModelLabel = (modelInfo) => {
  if (typeof modelInfo === 'string') {
    return modelInfo;
  }

  return getFirstTextValue(modelInfo?.label, modelInfo?.displayName, modelInfo?.name, modelInfo?.model, modelInfo?.id);
};

const formatCostAmount = (value, currency = 'USD') => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return String(value || '').trim();
  }

  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const precision = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6;
  return `${symbol}${amount.toFixed(precision).replace(/\.?0+$/, '')}`;
};

const getCostRate = (pricing, keys, unit) => {
  for (const key of keys) {
    const value = pricing?.[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const numericValue = Number(value);
    const shouldScaleTokenPrice = !unit && (key === 'prompt' || key === 'completion') && numericValue < 0.001;
    return {
      value: Number.isFinite(numericValue) && shouldScaleTokenPrice ? numericValue * 1_000_000 : value,
      unit: shouldScaleTokenPrice ? '1M tokens' : unit,
    };
  }

  return null;
};

const getAiCostText = (source) => {
  if (!source || typeof source !== 'object') {
    return '';
  }

  const directCost = getFirstTextValue(
    source.costLabel,
    source.priceLabel,
    source.pricingLabel,
    source.billingLabel,
    source.costDescription,
    source.priceDescription,
  );
  if (directCost) {
    return directCost;
  }

  if (source.free === true || source.isFree === true) {
    return MoodliaCorrectorI18n.t('free');
  }

  const pricing = source.pricing || source.price || source.cost || source.billing;
  if (typeof pricing === 'string') {
    return pricing.trim();
  }

  if (typeof pricing === 'number') {
    return formatCostAmount(pricing);
  }

  if (!pricing || typeof pricing !== 'object') {
    return '';
  }

  const nestedCost = getFirstTextValue(pricing.label, pricing.description, pricing.text);
  if (nestedCost) {
    return nestedCost;
  }

  const currency = pricing.currency || pricing.currencyCode || source.currency || 'USD';
  const unit = pricing.unit || pricing.per || pricing.rateUnit || '';
  const inputRate = getCostRate(
    pricing,
    ['inputUsdPerMillionTokens', 'inputUsdPer1MTokens', 'inputPerMillionTokens', 'input', 'prompt'],
    unit,
  );
  const outputRate = getCostRate(
    pricing,
    ['outputUsdPerMillionTokens', 'outputUsdPer1MTokens', 'outputPerMillionTokens', 'output', 'completion'],
    unit,
  );

  if (inputRate || outputRate) {
    const costUnit = inputRate?.unit || outputRate?.unit || unit || '1M tokens';
    return [
      inputRate ? MoodliaCorrectorI18n.message`input ${formatCostAmount(inputRate.value, currency)}` : '',
      outputRate ? MoodliaCorrectorI18n.message`output ${formatCostAmount(outputRate.value, currency)}` : '',
    ]
      .filter(Boolean)
      .join(' / ')
      .concat(' ', MoodliaCorrectorI18n.message`per ${costUnit}`);
  }

  const flatAmount = pricing.amount ?? pricing.value ?? pricing.rate;
  if (flatAmount !== undefined && flatAmount !== null && flatAmount !== '') {
    return `${formatCostAmount(flatAmount, currency)}${unit ? ` ${MoodliaCorrectorI18n.message`per ${unit}`}` : ''}`;
  }

  return '';
};

const createOptionLabelWithCost = (label, costText) => (costText ? `${label} - ${costText}` : label);

const renderAiRuntimeControls = () => {
  const { provider, model, runtimeState, runtimeCost } = getPanelElements();
  provider.replaceChildren();
  model.replaceChildren();
  runtimeCost.hidden = true;
  runtimeCost.textContent = '';

  if (!aiRuntimeStatus?.providers?.length) {
    provider.append(new Option(MoodliaCorrectorI18n.t('IA no disponible'), ''));
    model.append(new Option(MoodliaCorrectorI18n.t('Sin modelos'), ''));
    provider.disabled = true;
    model.disabled = true;
    runtimeState.textContent = MoodliaCorrectorI18n.t('No se ha detectado la IA o no ha devuelto capacidades.');
    updateAiChip();
    return;
  }

  const availableProviders = aiRuntimeStatus.providers.filter((item) => item.reachable || item.available);
  provider.disabled = false;
  for (const [id, definition] of Object.entries(MoodliaCorrectorAiProviders)) provider.append(new Option(MoodliaCorrectorI18n.t(definition.label), id));

  provider.value = aiRuntimeStatus.appConfig?.provider || '';
  const selectedProvider = availableProviders.find((item) => item.provider === provider.value);
  const models = selectedProvider?.models || [];

  model.disabled = !provider.value || models.length === 0;
  model.append(new Option(provider.value ? MoodliaCorrectorI18n.t('Modelo predeterminado') : MoodliaCorrectorI18n.t('Selecciona proveedor'), ''));

  const query = getPanelElements().panel.querySelector('[data-model-search]').value.trim().toLocaleLowerCase();
  const configuredModelId = aiRuntimeStatus.appConfig?.model || '';
  for (const modelInfo of models.filter(item => getModelId(item) === configuredModelId || `${getModelLabel(item)} ${getModelId(item)}`.toLocaleLowerCase().includes(query))) {
    const modelId = getModelId(modelInfo);
    if (!modelId) {
      continue;
    }

    model.append(new Option(createOptionLabelWithCost(getModelLabel(modelInfo) || modelId, getAiCostText(modelInfo)), modelId));
  }

  const configuredModel = aiRuntimeStatus.appConfig?.model || '';
  model.value = models.some((modelInfo) => getModelId(modelInfo) === configuredModel) ? configuredModel : '';
  const selectedModel = models.find((modelInfo) => getModelId(modelInfo) === model.value);
  const selectedCost = getAiCostText(selectedModel) || getAiCostText(selectedProvider);
  if (selectedCost) {
    runtimeCost.textContent = MoodliaCorrectorI18n.message`Coste: ${selectedCost}`;
    runtimeCost.hidden = false;
  }
  runtimeState.textContent =
    availableProviders.length > 0
      ? MoodliaCorrectorI18n.message`Listo. ${availableProviders.length} proveedor(es) disponible(s).`
      : aiRuntimeStatus.appConfig?.reason || MoodliaCorrectorI18n.t('No se ha podido conectar con la IA. Abre Opciones.');
  if (aiRuntimeStatus.appConfig?.reason) runtimeState.textContent = aiRuntimeStatus.appConfig.reason;
  else if (!aiRuntimeStatus.appConfig?.configured) runtimeState.textContent = MoodliaCorrectorI18n.t('Servidor conectado. Selecciona un modelo para corregir.');
  updateAiChip();
};

const refreshAiRuntimeStatus = async () => {
  const revision = ++aiStatusRevision;
  try {
    addPanelDiagnostic('ai.status.start');
    const response = await sendBackgroundMessage({ type: 'mca.getAiRuntimeStatus' });
    if (!response?.ok) {
      throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido leer el estado de la IA.'));
    }

    if (revision !== aiStatusRevision) return;
    aiRuntimeStatus = response.status;
    renderAiRuntimeControls();
    addPanelDiagnostic('ai.status.ok', {
      providers: response.status.providers?.length || 0,
      extension: response.status.extension?.id || null,
    });
    void refreshDiagnostics();
  } catch (error) {
    if (revision !== aiStatusRevision) return;
    aiRuntimeStatus = null;
    renderAiRuntimeControls();
    const message = error.message || String(error);
    getPanelElements().runtimeState.textContent = message;
    setPanelStatus(message);
    addPanelDiagnostic('ai.status.error', { message });
    void refreshDiagnostics();
  }
};

let aiSelectionRevision = 0;
const saveAiRuntimeSelection = async (providerChanged) => {
  const revision = ++aiSelectionRevision;
  ++aiStatusRevision;
  const { provider, model } = getPanelElements();
  const config = {
    ...(provider.value ? { provider: provider.value } : {}),
    ...(model.value && !providerChanged ? { model: model.value } : {}),
  };

  if (providerChanged) {
    const stored = await chrome.storage.local.get('mca.aiProviderConfigs');
    if (revision !== aiSelectionRevision) return;
    const profile = stored['mca.aiProviderConfigs']?.[config.provider];
    config.baseUrl = profile?.baseUrl || MoodliaCorrectorAiProviders[config.provider].baseUrl;
    config.model = profile?.model || '';
  }

  const response = await sendBackgroundMessage({
    type: 'mca.setAiRuntimeConfig',
    config,
  });
  if (revision !== aiSelectionRevision) return;

  if (!response?.ok) {
    setPanelStatus(response?.error || MoodliaCorrectorI18n.t('No se ha podido guardar la configuración de IA.'));
    return;
  }

  aiRuntimeStatus = {
    ...aiRuntimeStatus,
    appConfig: response.config,
  };
  renderAiRuntimeControls();
  await refreshAiRuntimeStatus();
  if (revision === aiSelectionRevision) setPanelStatus(MoodliaCorrectorI18n.t('Configuración de IA guardada.'));
};

let settingsFrame = null;
let settingsFrameRequest = null;
let panelConnectionTestId = null;
const setAiSettingsMode = async (mode) => {
  const panel = getPanelElements().panel;
  for (const button of panel.querySelectorAll('[data-ai-mode]')) {
    const selected = button.dataset.aiMode === mode;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('secondary', !selected);
  }
  panel.querySelector('[data-ai-simple]').hidden = mode !== 'simple';
  const advanced = panel.querySelector('[data-ai-advanced]');
  advanced.hidden = mode !== 'advanced';
  if (mode !== 'advanced') {
    if (settingsFrame) settingsFrame.contentWindow.postMessage({ type: 'mca.cancelSettingsTest', token: new URL(settingsFrame.src).searchParams.get('token') }, new URL(settingsFrame.src).protocol + '//' + new URL(settingsFrame.src).host);
    return;
  }
  if (!settingsFrame) {
    if (!settingsFrameRequest) settingsFrameRequest = sendBackgroundMessage({ type: 'mca.createSettingsFrame' }).finally(() => { settingsFrameRequest = null; });
    const response = await settingsFrameRequest;
    if (advanced.hidden || settingsFrame) return;
    if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se puede abrir la configuración avanzada.'));
    const frame = document.createElement('iframe');
    frame.title = MoodliaCorrectorI18n.t('Configuración avanzada de IA');
    frame.src = response.url;
    frame.style.cssText = 'width:100%;height:900px;border:0;display:block;background:white;';
    frame.referrerPolicy = 'no-referrer';
    settingsFrame = frame;
    advanced.replaceChildren(frame);
  }
};
window.addEventListener('message', event => {
  if (!settingsFrame || event.source !== settingsFrame.contentWindow || event.origin !== chrome.runtime.getURL('').replace(/\/$/, '') || event.data?.type !== 'mca.settingsFrameSize' || event.data.token !== new URL(settingsFrame.src).searchParams.get('token')) return;
  if (Number.isFinite(event.data.height)) settingsFrame.style.height = `${Math.min(3000, Math.max(200, event.data.height))}px`;
});
const testPanelAiConnection = async () => {
  const button = getPanelElements().panel.querySelector('[data-runtime-options]');
  if (panelConnectionTestId) {
    await sendBackgroundMessage({ type: 'mca.cancelCorrection', requestId: panelConnectionTestId });
    return;
  }
  const revision = gradingPageRevision;
  const requestId = crypto.randomUUID();
  panelConnectionTestId = requestId;
  button.textContent = MoodliaCorrectorI18n.t('Cancelar prueba');
  try {
    setPanelStatus(MoodliaCorrectorI18n.t('Probando la conexión con datos ficticios...'));
    const response = await sendBackgroundMessage({ type: 'mca.testAiConnection', requestId });
    if (revision !== gradingPageRevision || panelConnectionTestId !== requestId) return;
    if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido verificar la conexión.'));
    setPanelStatus(MoodliaCorrectorI18n.message`Conexión verificada: ${MoodliaCorrectorAiProviders[response.result.provider]?.label || response.result.provider} / ${response.result.model}.`);
  } catch (error) { if (revision === gradingPageRevision && panelConnectionTestId === requestId) setPanelStatus(error.message || String(error)); }
  finally { if (panelConnectionTestId === requestId) { panelConnectionTestId = null; button.textContent = MoodliaCorrectorI18n.t('Probar conexión'); } }
};
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes['mca.aiConfig'] && document.getElementById(PANEL_ID)) {
    if (settingsFrame && getPanelElements().panel.querySelector('[data-ai-advanced]').hidden) { settingsFrame.remove(); settingsFrame = null; }
    void refreshAiRuntimeStatus();
  }
});

const requestCorrectionFromPanel = async () => {
  const revision = gradingPageRevision;
  if (!currentAssignmentData) {
    await refreshPanelData();
  }
  if (revision !== gradingPageRevision) return;

  const { correction, correctButton, cancelButton } = getPanelElements();
  const assignmentForCorrection = await buildPanelAssignmentData();
  if (revision !== gradingPageRevision) return;
  setPanelStatus(MoodliaCorrectorI18n.t('Solicitando corrección a la IA...'));
  addPanelDiagnostic('correction.click', {
    files: assignmentForCorrection.submissionFiles.length,
    extraFiles: assignmentForCorrection.extraFiles.length,
    hasExtraInstructions: Boolean(assignmentForCorrection.extraInstructions),
    rubricCriteria: assignmentForCorrection.rubric.length,
  });
  correctButton.disabled = true;
  cancelButton.hidden = false;
  cancelButton.style.display = '';
  showCorrectionProgress(true);

  try {
    addPanelDiagnostic('correction.pageAi.start');
    const startedAt = Date.now();
    const result = await requestAiCorrectionFromPage(assignmentForCorrection, {
      onProgress: (progress) => {
        const status = progressStatus(progress);
        if (!status || revision !== gradingPageRevision) return;
        // The plan stays visible in the result area while the later stages update the status.
        if (progress.stage === 'plan') showCorrectionPlan(status);
        updateCorrectionProgress(progress, status);
        setPanelStatus(`${status} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      },
    });
    correctedStudents.add(currentStudentKey());
    if (revision !== gradingPageRevision) return;
    currentCorrection = result;
    updateExtraFilesSummary();
    renderCorrectionResult(currentCorrection);
    correction.value = JSON.stringify(currentCorrection.parsed || currentCorrection.text, null, 2);
    updateCorrectionProgress({ stage: 'apply' }, '');
    const applyResult = await applyCorrectionWhenReady(currentCorrection);
    if (revision !== gradingPageRevision) return;
    setPanelStatus(appliedStatus(applyResult));
    addPanelDiagnostic('correction.ok', {
      provider: currentCorrection.provider,
      model: currentCorrection.model,
      parsed: Boolean(currentCorrection.parsed),
      applied: applyResult,
    });
  } catch (error) {
    if (revision !== gradingPageRevision) return;
    const message = error.message || String(error);
    setPanelStatus(message);
    addPanelDiagnostic('correction.error', { message });
  } finally {
    if (revision === gradingPageRevision) {
      correctButton.disabled = false;
      cancelButton.hidden = true;
      cancelButton.style.display = 'none';
      showCorrectionProgress(false);
      if (!currentCorrection?.parsed) setCardLayout('start');
    }
  }
};

const applyCorrectionFromPanel = async () => {
  const revision = gradingPageRevision;
  if (!currentAssignmentData) {
    await refreshPanelData();
  }
  if (revision !== gradingPageRevision) return;

  const { externalCorrection, correction, applyCorrectionButton } = getPanelElements();
  const editedValue = externalCorrection.value.trim() || correction.value.trim();

  if (!editedValue) {
    setPanelStatus(MoodliaCorrectorI18n.t('Pega un JSON de corrección antes de aplicarlo.'));
    return;
  }

  let parsed;

  try {
    parsed = JSON.parse(editedValue);
  } catch (error) {
    const message = error.message || String(error);
    setPanelStatus(MoodliaCorrectorI18n.message`JSON inválido: ${message}`);
    addPanelDiagnostic('manualCorrection.invalidJson', { message });
    return;
  }

  const correctionToApply = {
    ...currentCorrection,
    parsed,
  };

  applyCorrectionButton.disabled = true;
  try {
    const result = await applyCorrectionWhenReady(correctionToApply);
    if (revision !== gradingPageRevision) return;
    currentCorrection = correctionToApply;
    renderCorrectionResult(currentCorrection);
    setPanelStatus(appliedStatus(result));
    addPanelDiagnostic('manualCorrection.applied', result);
  } catch (error) {
    if (revision === gradingPageRevision) throw error;
  } finally {
    if (revision === gradingPageRevision) applyCorrectionButton.disabled = false;
  }
};

const getNavigationIdentity = () => JSON.stringify({
  url: location.href,
  user: document.querySelector('input[name="userid"]')?.value || '',
  attempt: document.querySelector('input[name="attemptnumber"]')?.value || '',
  student: document.querySelector('[data-region="user-info"], .useridentity, .fullname, .submissionuser')?.textContent || '',
  instructionContext: getInstructionContext(),
  submission: document.querySelector('.assignsubmission_onlinetext, [data-region="submission-text"]')?.textContent || '',
  files: [...document.querySelectorAll('.assignsubmission_file a[href], .fileuploadsubmission a[href], a[href*="/assignsubmission_file/"]')].map(link => link.href),
});

// With "correct when moving to the next student" on, a correction starts once the
// next student's data is read. It never starts again for a student already
// corrected on this page (saving reloads the same student), and nothing is saved:
// the teacher still reviews and saves each grade.
const AUTO_CORRECT_STORAGE_KEY = 'mca.autoCorrectNext';
const correctedStudents = new Set();
const currentStudentKey = () => JSON.stringify([location.pathname, new URLSearchParams(location.search).get('id'),
  document.querySelector('input[name="userid"]')?.value || new URLSearchParams(location.search).get('userid') || '',
  document.querySelector('input[name="attemptnumber"]')?.value || '']);
let lastStudentKey = null;

const resetAssistantForNavigation = (refresh = true) => {
  gradingPageRevision++;
  const previousStudentKey = lastStudentKey;
  lastStudentKey = currentStudentKey();
  if (panelConnectionTestId) { void sendBackgroundMessage({ type: 'mca.cancelCorrection', requestId: panelConnectionTestId }).catch(() => {}); panelConnectionTestId = null; getPanelElements().panel.querySelector('[data-runtime-options]').textContent = MoodliaCorrectorI18n.t('Probar conexión'); }
  if (settingsFrame) { settingsFrame.contentWindow.postMessage({ type: 'mca.cancelSettingsTest', token: new URL(settingsFrame.src).searchParams.get('token') }, new URL(settingsFrame.src).origin); settingsFrame.remove(); settingsFrame = null; }
  void setAiSettingsMode('simple');
  savedInstructionsReady = instructionsController.setContext(isSupportedGraderUrl() ? getInstructionContext() : {});
  void savedInstructionsReady.then(updateCriteriaTabs, () => {});
  setPanelContext(null);
  showCorrectionProgress(false);
  const requestId = activeCorrectionRequestId;
  activeCorrectionRequestId = null;
  if (requestId) void sendBackgroundMessage({ type: 'mca.cancelCorrection', requestId }).catch(() => {});
  currentAssignmentData = null;
  currentCorrection = null;
  renderCorrectionResult(null);
  showPanelTool(getPanelElements().panel);
  clearTimeout(panelRefreshTimer);
  const elements = getPanelElements();
  for (const field of [elements.correction, elements.externalCorrection, elements.extraFiles]) field.value = '';
  elements.assignment.replaceChildren();
  elements.detectedList.replaceChildren();
  elements.diagnostics.replaceChildren();
  elements.gradingMode.textContent = MoodliaCorrectorI18n.t('Modo: pendiente de detectar');
  elements.correctButton.disabled = false;
  elements.applyCorrectionButton.disabled = false;
  elements.cancelButton.hidden = true;
  elements.cancelButton.style.display = 'none';
  // A new student starts with closed file groups and the criteria open.
  elements.panel.querySelector('[data-evidence-summary]').dataset.attention = 'false';
  elements.filePreview.replaceChildren(elements.addFiles);
  setCardLayout('start');
  updateExtraFilesSummary();
  setPanelStatus(MoodliaCorrectorI18n.t('Página cambiada. Corrector reiniciado.'));
  if (!isSupportedGraderUrl()) {
    closePanel();
    document.getElementById(FLOATING_BUTTON_ID).hidden = true;
    return;
  }
  document.getElementById(FLOATING_BUTTON_ID).hidden = false;
  if (refresh && elements.panel.dataset.open === 'true') {
    const revision = gradingPageRevision;
    const studentKey = lastStudentKey;
    const autoStart = previousStudentKey !== null && studentKey !== previousStudentKey && !correctedStudents.has(studentKey) && elements.panel.querySelector('[data-auto-correct]')?.checked;
    panelRefreshTimer = setTimeout(() => {
      void refreshPanelData().then(() => {
        if (autoStart && revision === gradingPageRevision && currentStudentKey() === studentKey) return requestCorrectionFromPanel();
        return undefined;
      }).catch((error) => {
        if (revision === gradingPageRevision) setPanelStatus(error.message);
      });
    }, 300);
  }
};

// Page observation runs only while the panel is open: a closed panel needs no live
// updates, and opening it first compares the page identity and resets if the
// student, attempt or page changed meanwhile. History and navigation events are
// cheap and stay attached, so leaving the grader still hides the button.
let navigationWatcher = null;
const watchGradingNavigation = () => {
  lastStudentKey = currentStudentKey();
  let identity = getNavigationIdentity();
  let watching = false;
  let checkTimer = null;
  let propertyTimer = null;
  const host = document.getElementById(PANEL_ID);
  const scalarIdentity = () => JSON.stringify([location.href,
    document.querySelector('input[name="userid"]')?.value || '',
    document.querySelector('input[name="attemptnumber"]')?.value || '',
    document.body.className.match(/\bcourse-(\d+)\b/)?.[1] || '']);
  let scalar = scalarIdentity();
  const pause = (state = isSupportedGraderUrl() ? 'paused' : 'stopped') => {
    watching = false;
    clearTimeout(checkTimer);
    checkTimer = null;
    clearInterval(propertyTimer);
    propertyTimer = null;
    observer.disconnect();
    host.dataset.navigationWatch = state;
  };
  const check = () => {
    checkTimer = null;
    if (!isSupportedGraderUrl()) {
      pause('stopped');
      identity = '';
      resetAssistantForNavigation(false);
      return;
    }
    const next = getNavigationIdentity();
    scalar = scalarIdentity();
    if (next !== identity) { identity = next; resetAssistantForNavigation(); }
  };
  const schedule = () => {
    if (watching && checkTimer === null) checkTimer = setTimeout(check, 100);
  };
  const observer = new MutationObserver(schedule);
  const observe = () => {
    if (!isSupportedGraderUrl()) return pause('stopped');
    if (getPanelElements().panel.dataset.open !== 'true') return pause('paused');
    if (watching) return undefined;
    watching = true;
    host.dataset.navigationWatch = 'active';
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
    // Only property changes lacking DOM/navigation events need a lightweight fallback.
    propertyTimer = setInterval(() => {
      const next = scalarIdentity();
      if (next !== scalar) { scalar = next; check(); }
    }, 1000);
    return undefined;
  };
  const navigate = () => { check(); observe(); };
  window.addEventListener('popstate', navigate);
  window.addEventListener('hashchange', navigate);
  window.navigation?.addEventListener('currententrychange', navigate);
  window.addEventListener('pagehide', () => { pause('stopped'); identity = ''; resetAssistantForNavigation(false); });
  window.addEventListener('pageshow', event => { if (event.persisted) navigate(); });
  navigationWatcher = { check, observe, pause };
  observe();
};

const initializeAssistantUi = () => {
  createFloatingButton();
  createSidePanel();
  updateExtraFilesSummary();
  const elements = getPanelElements();
  instructionsController = MoodliaCorrectorPreferences.createController({
    course: elements.courseInstructions, assignment: elements.assignmentInstructions, case: elements.extraInstructions,
  }, setPanelStatus, elements.recoverInstructions);
  savedInstructionsReady = instructionsController.setContext(getInstructionContext());
  void savedInstructionsReady.then(updateCriteriaTabs, () => {});
  watchGradingNavigation();
};

if (isSupportedGraderUrl()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'mca.openPanel') {
      openPanel();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'mca.cancelCorrectionFromPage') {
      void cancelCorrectionFromPage()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'mca.extractAssignment') {
      void extractAssignmentData()
        .then((assignmentData) => {
          currentAssignmentData = assignmentData;
          savedInstructionsReady = instructionsController.setContext(assignmentData.instructionContext);
          updateExtraFilesSummary();
          sendResponse({ ok: true, assignmentData });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message?.type === 'mca.applyCorrection') {
      void applyCorrectionWhenReady(message.correction)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message?.type === 'mca.requestCorrection') {
      void waitForGradingPanelReady()
        .then(() =>
          message.assignmentData || extractAssignmentData(),
        )
        .then((assignmentData) => {
          if (!message.assignmentData) currentAssignmentData = assignmentData;
          return requestAiCorrectionFromPage(assignmentData);
        })
        .then((correction) => sendResponse({ ok: true, correction }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    return false;
  });

  initializeAssistantUi();
}

})();
