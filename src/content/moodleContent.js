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
  version: '0.1.67',
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

const extractSubmissionFiles = () => {
  const links = [
    ...document.querySelectorAll(
      '.assignsubmission_file a, .fileuploadsubmission a, a[href*="pluginfile.php"], a[href*="/assignsubmission_file/"]',
    ),
  ];

  const seen = new Set();
  return links
    .filter((link) => {
      if (!link.closest('.assignsubmission_file, .fileuploadsubmission') && !/\/assignsubmission_file\//i.test(link.href)) return false;
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    })
    .map((link, index) => {
      const originalName =
        getVisibleText(link) || link.getAttribute('title') || link.href.split('/').pop() || 'File';
      const extension = getFileExtension(originalName);

      return {
        id: `submission-file-${index + 1}`,
        name: `submission-file-${index + 1}${extension}`,
        originalName,
        url: link.href,
      };
    });
};

const getFileExtension = (fileName) => {
  const cleanName = String(fileName || '').split('?')[0].trim();
  const match = cleanName.match(/(\.[a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : '';
};


const extractOnlineText = () => {
  return findFirstText([
    '.assignsubmission_onlinetext',
    '[class*="assignsubmission_onlinetext"]',
    '[id*="assignsubmission_onlinetext"]',
    '.submissiontext',
  ]);
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
}[extension] || (extension ? `Archivo ${extension.slice(1).toUpperCase()}` : MoodliaCorrectorI18n.t('Archivo enlazado')));

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
      if (!introFile && !download && !/\.(odt|docx?|pdf|ods|xlsx?|odp|pptx?|zip|txt|csv|png|jpe?g|webp|gif|svg|mp4|mp3)$/i.test(extension)) continue;
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
    description.textContent = `${file.typeDescription}. ${file.embedded ? 'Imagen incluida en el enunciado.' : file.label || MoodliaCorrectorI18n.t('Archivo enlazado desde el enunciado.')}`;
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
    const text = getVisibleText(element);
    if (text) {
      return text;
    }
  }

  return '';
};

const fetchAssignmentDescription = async (descriptionLink) => {
  if (!descriptionLink?.url || !isSameOriginUrl(descriptionLink.url)) {
    return null;
  }

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
    userId: document.querySelector('input[name="userid"]')?.value || url.searchParams.get('userid') || '',
    attemptId: document.querySelector('input[name="attemptnumber"]')?.value || url.searchParams.get('attemptnumber') || '0',
  };
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
    formUser: document.querySelector('input[name="userid"]')?.value || '',
    student: extractStudentName(),
    submission: extractSubmissionText(),
    files: extractSubmissionFiles().map((file) => file.url),
    maxScore: extractMaxScore(),
    rubric: extractRubric().map(({ id, levels }) => ({ id, levels: levels.map(({ id, value, text, score, index }) => ({ id, value, text, score, index })) })),
  });
};

const assertGradingContext = (expected) => {
  if (!expected || expected !== getGradingContext()) {
    throw new Error(MoodliaCorrectorI18n.t('El alumno, la tarea o la entrega han cambiado. Vuelve a extraer los datos y solicita otra corrección.'));
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
  return null;
};

const describeGradingMode = (assignmentData) => {
  const labels = { 'simple-direct': MoodliaCorrectorI18n.t('Calificación directa simple'), rubric: MoodliaCorrectorI18n.t('Rúbrica'), 'grading-guide': MoodliaCorrectorI18n.t('Guía de evaluación') };
  const label = labels[assignmentData?.correctionMethod] || MoodliaCorrectorI18n.t('Método no detectado');
  if (assignmentData?.correctionMethod !== 'simple-direct') return MoodliaCorrectorI18n.message`Modo: ${label}`;
  return MoodliaCorrectorI18n.message`Modo: ${label} · ${assignmentData.maxScore === null ? MoodliaCorrectorI18n.t('máximo no detectado') : MoodliaCorrectorI18n.message`sobre ${assignmentData.maxScore}`}`;
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

  const criterion = document.querySelector('[id^="advancedgrading-criteria-"]:not([id*="-levels-"])');
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

const extractGradingGuide = () => {
  const guideRoot = document.querySelector('.gradingform_guide, [data-grading-method="guide"]');
  if (!guideRoot) {
    return [];
  }

  return [...guideRoot.querySelectorAll('.criterion, tr[id*="criterion" i], [data-criterion-id]')]
    .map((row, index) => ({
      id: row.getAttribute('data-criterion-id') || row.id || `guide-criterion-${index + 1}`,
      description:
        getVisibleText(row.querySelector('.description, .criteriondescription, th')) ||
        getVisibleText(row).slice(0, 500),
      maxScore:
        row.querySelector('input[name*="score" i], input[id*="score" i]')?.getAttribute('max') ||
        row.querySelector('[class*="score" i]')?.textContent?.trim() ||
        null,
    }))
    .filter((criterion) => criterion.description);
};

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

const extractAssignmentData = async () => {
  await waitForGradingPanelReady();
  const gradingContext = getGradingContext();
  const descriptionLink = extractAssignmentDescriptionLink();
  const linkedDescription = await fetchAssignmentDescription(descriptionLink);
  const submissionFiles = extractSubmissionFiles();
  const correctionMethod = extractCorrectionMethod();
  const finalFeedbackBox = findCommentBox();
  const gradeInput = findGradeInput();
  const rubric = correctionMethod.rubric;
  const inlinePrompt = extractDescriptionFromDocument(document);
  const assignmentFiles = extractAssignmentFiles(document);
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
    rubric,
    gradingGuide: correctionMethod.guide,
    gradingControls: {
      grade: Boolean(gradeInput),
      gradeType: getElementControlType(gradeInput),
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
    const candidate = [...document.querySelectorAll(selector)].find((input) =>
      ['text', 'number'].includes(input.type) && !input.disabled && !input.readOnly);
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

const setTinyMceIframeValue = (element, value) => {
  const id = element?.id || '';
  if (!id) {
    return false;
  }

  const frame = document.getElementById(`${id}_ifr`);
  const body = frame?.contentDocument?.body;
  if (!body) {
    return false;
  }

  body.textContent = value;
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

const setElementValue = (element, value) => {
  if (!element) {
    return false;
  }

  const editable = findAssociatedEditable(element);

  if ('value' in element) {
    element.value = value;
  } else {
    element.textContent = value;
  }

  if (editable && editable !== element) {
    editable.textContent = value;
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
  }
  setTinyMceIframeValue(element, value);

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
  if (!input) {
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

const selectRubricLevel = (criterionElement, levelIndex, expectedLevelValues = []) => {
  if (!criterionElement || !Number.isInteger(levelIndex)) {
    return { applied: false, reason: 'missing-criterion-or-level-index' };
  }

  const expectedValues = Array.isArray(expectedLevelValues)
    ? expectedLevelValues.map((value) => String(value))
    : [String(expectedLevelValues || '')].filter(Boolean);
  const levelNodes = getRubricLevelElements(criterionElement);
  const targetLevel = levelNodes[levelIndex] || findRubricLevelElementByValues(criterionElement, expectedValues) || null;
  const levelValues = getRubricLevelCandidateValues(null, targetLevel);
  const candidateValues = [...new Set([...expectedValues, ...levelValues])];

  const input = findLevelInputByValues(criterionElement, candidateValues) || findLevelInput(targetLevel, criterionElement, levelIndex);

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
  if (parsed?.needsRepair || parsed?.rubricSelections?.some((selection) => !Number.isInteger(selection.levelIndex))) {
    throw new Error(MoodliaCorrectorI18n.t('La rúbrica contiene una selección inválida. Revisa la corrección antes de aplicarla.'));
  }
  for (const selection of parsed.rubricSelections || []) {
    const definition = getRubricCriterionDefinition(selection);
    if (!definition || !findCriterionElement(selection.criterionId) || !getRubricLevelDefinition(definition, selection.levelIndex)) {
      throw new Error(MoodliaCorrectorI18n.t('No se ha podido identificar el criterio de rúbrica. Actualiza los datos antes de aplicar.'));
    }
  }
  const feedback = parsed?.studentFeedback || parsed?.feedback || '';
  const score = parsed?.score;
  const commentBox = findCommentBox();
  const gradeInput = findGradeInput();

  const commentApplied = feedback ? setElementValue(commentBox, feedback) : false;
  const gradeApplied =
    score !== undefined && score !== null ? setElementValue(gradeInput, String(score)) : false;
  const rubricApplied = applyRubricSelections(parsed?.rubricSelections);
  const result = {
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

const applyCorrectionWhenReady = async (correction) => {
  await waitForGradingPanelReady();
  assertGradingContext(correction?.gradingContext || currentAssignmentData?.gradingContext);
  return applyCorrection(correction);
};

const sendBackgroundMessage = (message) => MoodliaCorrectorRuntime.send(message);

const { getExpectedMaxScore, getFinalComment, normalizeCorrectionResponse } = MoodliaCorrectorSchema;

let activeCorrectionRequestId = null;
const requestAiCorrectionFromPage = async (assignmentData) => {
  if (activeCorrectionRequestId) throw new Error(MoodliaCorrectorI18n.t('Ya hay una corrección en curso.'));
  const gradingContext = assignmentData.gradingContext;
  assertGradingContext(gradingContext);
  const requestId = crypto.randomUUID();
  activeCorrectionRequestId = requestId;
  try {
    const response = await sendBackgroundMessage({
      type: 'mca.correctAssignment',
      assignmentData,
      requestId,
    });

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
    [MoodliaCorrectorI18n.t('Corrección'), describeGradingMode(assignmentData).replace(/^Modo: /, '')],
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
    assignmentData.linkedAssignmentDescription?.text ? 'Descripción enlazada de la tarea' : 'Instrucciones',
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
      controls.textContent = `Niveles: ${criterion.controls?.levelSelection ? 'seleccionables' : MoodliaCorrectorI18n.t('no seleccionables')} · Comentario: ${
        criterion.controls?.criterionComment ? `detectado (${criterion.controls.criterionCommentType})` : MoodliaCorrectorI18n.t('no detectado')
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
          const status = levelData.selectable ? 'seleccionable' : 'detectado';
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
      title.textContent = criterion.description || criterion.id;
      const score = document.createElement('p');
      score.textContent = criterion.maxScore ? MoodliaCorrectorI18n.message`Puntuación máxima: ${criterion.maxScore}` : MoodliaCorrectorI18n.t('No se ha detectado puntuación');
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
      color: #182033;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }

    button, select, textarea {
      font: inherit;
    }

    [hidden] { display: none !important; }
    button:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: 2px solid #2453a6;
      outline-offset: 3px;
    }
    .panel-tools { grid-column: 1 / -1; display: flex; gap: 8px; }
    .panel-overview { grid-column: 1 / -1; border-top: 1px solid #dfe4ee; padding-top: 10px; }
    .panel-overview [data-grading-mode] { margin: 0; color: #213b65; font-size: 15px; font-weight: 750; }
    .panel-overview [data-status] { margin: 4px 0 0; color: #365075; font-size: 13px; font-weight: 550; }
    .tool-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      padding: 8px;
      color: #365075;
      background: #eef2f7;
    }
    .tool-button:hover, .tool-button[aria-expanded="true"] { background: #dce7f8; color: #183c79; }
    .tool-button svg { width: 22px; height: 22px; }
    .technical-pane { display: grid; gap: 16px; background: #fff; padding: 14px; border-radius: 8px; }
    .technical-pane > h3 { margin: 0; font-size: 15px; }
    .technical-pane .runtime-card, .technical-pane .field-stack { padding: 0; border: 0; }
    .instruction-fields { display: grid; gap: 8px; }
    .instruction-fields textarea {
      min-height: 110px;
      font: inherit;
      white-space: pre-wrap;
    }
    [data-result] { white-space: pre-wrap; overflow-wrap: anywhere; }
    .result-score { font-size: 16px; font-weight: 700; }

    button {
      border: 0;
      border-radius: 7px;
      cursor: pointer;
    }

    .floating-button {
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 2147483646;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      height: 46px;
      padding: 0;
      background: #2453a6;
      box-shadow: 0 10px 24px rgba(20, 33, 61, 0.22);
    }

    .floating-button svg {
      width: 32px;
      height: 32px;
      display: block;
    }

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
      background: #f4f6f9;
      border-left: 1px solid #d5dbe7;
      box-shadow: none;
      transform: translateX(100%);
      transition: transform 180ms ease;
    }

    .panel[data-open="true"] {
      transform: none;
    }

    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: start;
      padding: 15px 16px 13px;
      border-bottom: 1px solid #dfe4ee;
      background: #fff;
    }

    .title {
      margin: 0;
      font-size: 16px;
      font-weight: 750;
    }

    .status {
      margin: 4px 0 0;
      color: #566273;
      font-size: 12px;
    }

    .workflow {
      display: grid;
      gap: 12px;
    }

    .workflow-card {
      display: grid;
      gap: 10px;
      padding: 12px;
      border: 1px solid #dfe4ee;
      border-radius: 8px;
      background: #fff;
    }

    .workflow-card.primary {
      border-color: #b8c8e8;
      box-shadow: 0 8px 24px rgba(36, 83, 166, 0.08);
    }

    .card-heading {
      display: grid;
      grid-template-columns: 26px 1fr;
      gap: 9px;
      align-items: start;
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: #2453a6;
      color: #fff;
      font-size: 12px;
      font-weight: 800;
    }

    .card-heading h3 {
      margin: 0;
      color: #1f2b3d;
      font-size: 13px;
      font-weight: 800;
    }

    .card-heading p {
      margin: 2px 0 0;
      color: #657184;
      font-size: 12px;
    }

    .close-button {
      width: 30px;
      height: 30px;
      color: #243044;
      background: #eef2f7;
      font-size: 18px;
      line-height: 1;
    }

    .action-button {
      min-height: 34px;
      padding: 0 10px;
      color: #fff;
      background: #2453a6;
      font-weight: 700;
    }

    .action-button.secondary {
      color: #1f2b3d;
      background: #e9eef6;
    }

    .action-button.full-width {
      width: 100%;
    }

    .action-button:disabled {
      cursor: not-allowed;
      color: #f2f4f7;
      background: #8b96a6;
    }

    .content {
      overflow: auto;
      padding: 14px;
    }

    .section {
      display: grid;
      gap: 8px;
      margin-bottom: 14px;
    }

    .field-stack {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid #dfe4ee;
      border-radius: 7px;
      background: #fff;
    }

    .field-stack label {
      color: #394456;
      font-weight: 700;
    }

    .field-stack textarea {
      min-height: 96px;
      font: inherit;
      white-space: normal;
    }

    .field-stack textarea.code-input {
      min-height: 210px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      white-space: pre;
    }

    .file-input {
      width: 100%;
      padding: 8px;
      border: 1px dashed #b7c2d4;
      border-radius: 7px;
      background: #f9fbfe;
      color: #1d232f;
      box-sizing: border-box;
    }

    .hint {
      margin: 0;
      color: #6a7482;
      font-size: 12px;
    }

    .json-actions {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }

    .section-title {
      margin: 0;
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
      color: #536070;
    }

    .supervision {
      border: 1px solid #d8deea;
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }

    .supervision > summary {
      display: grid;
      gap: 2px;
      padding: 11px 12px;
      cursor: pointer;
      color: #1f2b3d;
      font-weight: 800;
      list-style: none;
    }

    .supervision > summary::-webkit-details-marker,
    .nested-disclosure > summary::-webkit-details-marker,
    .rubric-item > summary::-webkit-details-marker {
      display: none;
    }

    .supervision > summary::after,
    .nested-disclosure > summary::after,
    .rubric-item > summary::after {
      content: "+";
      justify-self: end;
      margin-top: -20px;
      color: #637188;
      font-weight: 900;
    }

    .supervision[open] > summary::after,
    .nested-disclosure[open] > summary::after,
    .rubric-item[open] > summary::after {
      content: "-";
    }

    .supervision-note {
      margin: 0;
      color: #657184;
      font-size: 12px;
      font-weight: 500;
    }

    .supervision-body {
      display: grid;
      gap: 10px;
      padding: 0 12px 12px;
    }

    .ai-mode-switch { position: sticky; top: 0; z-index: 3; background: #fff; padding: 8px 0; }
    [data-ai-simple] { display: grid; gap: 10px; }
    [data-ai-simple][hidden] { display: none; }
    .runtime-card {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid #dfe4ee;
      border-radius: 7px;
      background: #fff;
    }

    .runtime-state {
      margin: 0;
      color: #5b6676;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .runtime-row {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
    }

    .runtime-row input[type="search"] {
      width: 100%; min-width: 0; min-height: 32px; box-sizing: border-box;
      border: 1px solid #c9d0dc; border-radius: 7px; padding: 0 8px;
      background: #fff; color: #1d232f; font: inherit;
    }
    .runtime-row select { min-width: 0; }
    .runtime-row label {
      color: #5b6676;
      font-weight: 650;
    }

    select {
      width: 100%;
      min-height: 32px;
      border: 1px solid #c9d0dc;
      border-radius: 7px;
      background: #fff;
      color: #1d232f;
      padding: 0 8px;
    }

    .runtime-cost {
      margin: -2px 0 0 86px;
      color: #5b6676;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .runtime-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .diagnostics {
      display: grid;
      gap: 5px;
      max-height: 160px;
      overflow: auto;
      padding: 8px;
      border: 1px solid #dfe4ee;
      border-radius: 7px;
      background: #fff;
      color: #273244;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .diagnostic-entry {
      padding-bottom: 5px;
      border-bottom: 1px solid #edf0f5;
    }

    .detected-list {
      display: grid;
      gap: 6px;
      margin: 0;
    }

    .detected-list div {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px;
      padding: 7px 0;
      border-bottom: 1px solid #e3e7ef;
    }

    .detected-list dt {
      color: #5b6676;
      font-weight: 650;
    }

    .detected-list dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .summary-card {
      display: grid;
      gap: 7px;
      padding: 0;
      border: 1px solid #dfe4ee;
      border-radius: 7px;
      background: #fff;
    }

    .summary-card > summary,
    .rubric-item > summary {
      cursor: pointer;
      padding: 9px 10px;
      margin: 0;
      font-size: 13px;
      font-weight: 750;
      color: #273244;
    }

    .summary-card > :not(summary),
    .rubric-item > :not(summary) {
      margin: 0 10px 10px;
    }

    .text-block {
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #273244;
    }

    .compact-list {
      display: grid;
      gap: 6px;
      margin: 0;
    }

    .compact-list div {
      display: grid;
      grid-template-columns: 80px 1fr;
      gap: 8px;
    }

    .compact-list dt {
      color: #5b6676;
      font-weight: 650;
    }

    .compact-list dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .plain-list {
      overflow-wrap: anywhere;
      display: grid;
      gap: 5px;
      margin: 0;
      padding-left: 18px;
    }

    .plain-list a {
      color: #2453a6;
      text-decoration: underline;
      overflow-wrap: anywhere;
    }

    .rubric-list {
      display: grid;
      gap: 8px;
    }

    .rubric-item {
      display: grid;
      gap: 4px;
      border: 1px solid #e8ecf3;
      border-radius: 7px;
      background: #fbfcfe;
    }

    .rubric-item p {
      margin: 0;
      color: #5b6676;
    }

    .level-list {
      display: grid;
      gap: 5px;
      margin: 0;
      padding-left: 18px;
    }

    .level-list li {
      color: #273244;
      overflow-wrap: anywhere;
    }

    textarea {
      width: 100%;
      min-height: 220px;
      padding: 9px;
      border: 1px solid #c9d0dc;
      border-radius: 7px;
      resize: vertical;
      background: #fff;
      color: #1d232f;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      box-sizing: border-box;
      white-space: pre;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      color: #6a7482;
      background: #fff;
      border-top: 1px solid #dfe4ee;
      font-size: 12px;
    }

    .footer-note {
      margin: 0;
    }

    .footer .action-button {
      min-width: 142px;
      white-space: nowrap;
    }
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

const PANEL_TOOL_ICONS = {
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  json: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  inspect: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};

const showPanelTool = (panel, selected = '', restoreFocus = false) => {
  const previous = panel.dataset.activeTool || '';
  panel.dataset.activeTool = selected;
  panel.querySelector('[data-main-workflow]').hidden = Boolean(selected);
  for (const pane of panel.querySelectorAll('[data-tool-pane]')) pane.hidden = pane.dataset.toolPane !== selected;
  for (const button of panel.querySelectorAll('[data-tool]')) button.setAttribute('aria-expanded', String(button.dataset.tool === selected));
  panel.querySelector('.content').scrollTop = 0;
  if (selected) panel.querySelector(`[data-tool-pane="${selected}"] h3`).focus();
  else if (restoreFocus && previous) panel.querySelector(`[data-tool="${previous}"]`).focus();
};

const renderCorrectionResult = (correction) => {
  const container = getPanelElements().result;
  const parsed = correction?.parsed;
  container.replaceChildren();
  if (!parsed) {
    container.textContent = MoodliaCorrectorI18n.t('Aquí verás la nota propuesta y el comentario de la corrección.');
    return;
  }
  if (typeof parsed.score === 'number') {
    const score = document.createElement('p');
    score.className = 'result-score';
    score.textContent = MoodliaCorrectorI18n.message`Nota propuesta: ${parsed.score}${parsed.maxScore !== null && parsed.maxScore !== undefined ? ` / ${parsed.maxScore}` : ''}`;
    container.appendChild(score);
  }
  const feedback = document.createElement('p');
  feedback.textContent = getFinalComment(parsed) || MoodliaCorrectorI18n.t('Sin comentario final.');
  container.appendChild(feedback);
  for (const [index, criterion] of (parsed.rubricSelections || []).entries()) {
    const paragraph = document.createElement('p');
    paragraph.textContent = `${currentAssignmentData?.rubric?.[index]?.description || MoodliaCorrectorI18n.message`Criterio ${index + 1}`}: ${criterion.criterionFeedback || ''}`;
    container.appendChild(paragraph);
  }
};

const organizePanelWorkflow = (panel) => {
  const content = panel.querySelector('.content');
  const [externalJsonSection, runtimeSection, diagnosticsSection, detectedSection, instructionsSection, assignmentSection, correctionSection] =
    [...content.querySelectorAll(':scope > .section')];
  correctionSection.querySelector('textarea').setAttribute('aria-label', MoodliaCorrectorI18n.t('JSON de la sugerencia de IA'));
  const workflow = document.createElement('div');
  workflow.className = 'workflow';
  workflow.dataset.mainWorkflow = 'true';
  instructionsSection.className = 'workflow-card';
  instructionsSection.querySelector('.field-stack').classList.remove('field-stack');
  const instructionFields = instructionsSection.querySelector('h3').nextElementSibling;
  instructionFields.classList.add('instruction-fields');
  instructionsSection.querySelector('h3').textContent = MoodliaCorrectorI18n.t('Criterio docente');

  const filePreview = document.createElement('section');
  filePreview.className = 'workflow-card';
  const fileHeading = document.createElement('h3');
  fileHeading.className = 'section-title';
  fileHeading.textContent = MoodliaCorrectorI18n.t('Archivos para la IA');
  const fileList = document.createElement('div');
  fileList.dataset.filePreview = 'true';
  filePreview.append(fileHeading, fileList);

  const resultSection = document.createElement('section');
  resultSection.className = 'workflow-card';
  const resultHeading = document.createElement('h3');
  resultHeading.className = 'section-title';
  resultHeading.textContent = MoodliaCorrectorI18n.t('Resultado');
  const result = document.createElement('div');
  result.dataset.result = 'true';
  result.setAttribute('aria-live', 'polite');
  result.textContent = MoodliaCorrectorI18n.t('Aquí verás la nota propuesta y el comentario de la corrección.');
  resultSection.append(resultHeading, result);
  workflow.append(filePreview, instructionsSection, resultSection);

  const tools = document.createElement('nav');
  tools.className = 'panel-tools';
  tools.setAttribute('aria-label', MoodliaCorrectorI18n.t('Herramientas del corrector'));
  const panes = [];
  for (const [id, title, sections] of [
    ['settings', MoodliaCorrectorI18n.t('Configuración de IA'), [runtimeSection]],
    ['json', MoodliaCorrectorI18n.t('JSON de corrección'), [externalJsonSection, correctionSection]],
    ['inspect', MoodliaCorrectorI18n.t('Datos y diagnóstico'), [detectedSection, assignmentSection, diagnosticsSection]],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-button';
    button.dataset.tool = id;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `mca-tool-${id}`);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PANEL_TOOL_ICONS[id]}</svg>`;
    const pane = document.createElement('section');
    pane.id = `mca-tool-${id}`;
    pane.dataset.toolPane = id;
    pane.className = 'technical-pane';
    pane.hidden = true;
    pane.setAttribute('aria-labelledby', `mca-tool-title-${id}`);
    const heading = document.createElement('h3');
    heading.id = `mca-tool-title-${id}`;
    heading.tabIndex = -1;
    heading.textContent = title;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'action-button secondary';
    back.textContent = MoodliaCorrectorI18n.t('Volver a la corrección');
    back.addEventListener('click', () => showPanelTool(panel, '', true));
    pane.append(heading, back, ...sections);
    button.addEventListener('click', () => showPanelTool(panel, panel.dataset.activeTool === id ? '' : id));
    panes.push(pane);
    tools.appendChild(button);
  }
  const overview = document.createElement('div');
  overview.className = 'panel-overview';
  const status = panel.querySelector('[data-status]');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  overview.append(panel.querySelector('[data-grading-mode]'), status);
  panel.querySelector('.header').append(tools, overview);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.dataset.activeTool) {
      event.preventDefault();
      event.stopPropagation();
      showPanelTool(panel, '', true);
    }
  });
  content.replaceChildren(workflow, ...panes);
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
      <div>
        <h2 class="title">Corrector de Moodle</h2>
        <p class="status" data-grading-mode role="status" aria-live="polite">Modo: pendiente de detectar</p>
        <p class="status" data-status>Listo.</p>
      </div>
      <button class="close-button" type="button" data-close aria-label="Cerrar">x</button>
    </header>
    <div class="content">
      <section class="section">
        <h3 class="section-title">JSON externo</h3>
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
        <h3 class="section-title">IA</h3>
        <div class="runtime-card">
          <p class="runtime-state" data-runtime-state role="status" aria-live="polite">Comprobando la IA...</p>
          <div class="runtime-actions ai-mode-switch" role="group" aria-label="Modo de configuración de IA">
            <button class="action-button" type="button" data-ai-mode="simple" aria-pressed="true">Simple</button>
            <button class="action-button secondary" type="button" data-ai-mode="advanced" aria-pressed="false">Avanzado</button>
          </div>
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
      <section class="section">
        <h3 class="section-title">Diagnóstico</h3>
        <div class="diagnostics" data-diagnostics></div>
      </section>
      <section class="section">
        <h3 class="section-title">Detectado</h3>
        <dl class="detected-list" data-detected-list></dl>
      </section>
      <section class="section">
        <h3 class="section-title">Indicaciones adicionales</h3>
        <div class="field-stack">
          <label for="mca-course-instructions">Por curso</label>
          <p class="hint">Para todas las tareas de este curso.</p>
          <textarea id="mca-course-instructions" data-course-instructions placeholder="Criterios generales del curso..."></textarea>
          <label for="mca-assignment-instructions">Por tarea</label>
          <p class="hint">Para todos los alumnos de esta tarea.</p>
          <textarea id="mca-assignment-instructions" data-assignment-instructions placeholder="Qué valorar en esta tarea..."></textarea>
          <button class="action-button secondary" type="button" data-recover-instructions hidden>Copiar instrucciones anteriores a esta tarea</button>
          <label for="mca-extra-instructions">Por caso concreto</label>
          <p class="hint">Solo para este alumno e intento de esta tarea.</p>
          <textarea id="mca-extra-instructions" data-extra-instructions placeholder="Ej.: valora especialmente la claridad de las actividades, penaliza si no hay evidencias del uso de IA..."></textarea>
          <label for="mca-extra-files">Archivos adicionales</label>
          <input class="file-input" id="mca-extra-files" data-extra-files type="file" multiple />
          <p class="hint" data-extra-files-summary>Sin archivos adicionales.</p>
        </div>
      </section>
      <section class="section">
        <h3 class="section-title">Información usada para corregir</h3>
        <div data-assignment></div>
      </section>
      <section class="section">
        <h3 class="section-title">Sugerencia de IA</h3>
        <textarea data-correction spellcheck="false"></textarea>
      </section>
    </div>
    <footer class="footer">
      <p class="footer-note">Revisa antes de guardar. La extensión no envía el formulario.</p>
      <button class="action-button" type="button" data-correct>Corregir con IA</button>
      <button class="action-button secondary" type="button" data-cancel-correction hidden style="display:none">Cancelar</button>
    </footer>
  `;

  organizePanelWorkflow(panel);
  MoodliaCorrectorI18n.localize(panel);

  panel.querySelector('[data-close]').addEventListener('click', closePanel);
  panel.querySelector('[data-correct]').addEventListener('click', () => void requestCorrectionFromPanel().catch(error => setPanelStatus(error.message || String(error))));
  panel.querySelector('[data-cancel-correction]').addEventListener('click', () => void cancelCorrectionFromPage().catch((error) => setPanelStatus(error.message)));
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
  const { extraFiles, extraFilesSummary, filePreview } = getPanelElements();
  const files = [...(extraFiles?.files || [])];
  MoodliaCorrectorFilePreview.render(filePreview, currentAssignmentData, files, currentCorrection?.skippedFiles || []);

  if (files.length === 0) {
    extraFilesSummary.textContent = MoodliaCorrectorI18n.t('Sin archivos adicionales.');
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  extraFilesSummary.textContent = MoodliaCorrectorI18n.message`${files.length} archivo(s) adicional(es), ${(totalBytes / 1024 / 1024).toFixed(2)} MB.`;
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
  panel.dataset.open = 'true';
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
  setPageShift(false);
};

const updateDetectedList = (assignmentData) => {
  const { detectedList, gradingMode } = getPanelElements();
  gradingMode.textContent = describeGradingMode(assignmentData);
  const gradingControls = assignmentData.gradingControls || {};
  const entries = [
    ['Tarea Moodle', assignmentData.page.detectedAsMoodleAssignment ? 'Sí' : MoodliaCorrectorI18n.t('No')],
    [MoodliaCorrectorI18n.t('Título'), assignmentData.assignmentTitle || MoodliaCorrectorI18n.t('No detectado')],
    [
      MoodliaCorrectorI18n.t('Descripción'),
      assignmentData.assignmentDescriptionLink?.url
        ? assignmentData.linkedAssignmentDescription?.text
          ? 'Enlace y contenido recuperados'
          : 'Enlace detectado'
        : MoodliaCorrectorI18n.t('No detectada'),
    ],
    ['Instrucciones', assignmentData.assignmentPrompt ? `${assignmentData.assignmentPrompt.length} caracteres` : MoodliaCorrectorI18n.t('No detectadas')],
    [MoodliaCorrectorI18n.t('Texto en línea'), assignmentData.submissionText ? `${assignmentData.submissionText.length} caracteres` : MoodliaCorrectorI18n.t('No detectado')],
    [MoodliaCorrectorI18n.t('Archivos entregados'), MoodliaCorrectorI18n.message`${assignmentData.submissionFiles.length} archivo(s)`],
    [MoodliaCorrectorI18n.t('Archivos del enunciado'), MoodliaCorrectorI18n.message`${assignmentData.assignmentFiles?.length || 0} archivo(s)`],
    [MoodliaCorrectorI18n.t('Rúbrica'), MoodliaCorrectorI18n.message`${assignmentData.rubric.length} criterio(s)`],
    [
      MoodliaCorrectorI18n.t('Controles de rúbrica'),
      assignmentData.rubric.length
        ? `${gradingControls.rubricCriteriaWithLevelControls || 0}/${assignmentData.rubric.length} controles de nivel, ${gradingControls.rubricCriteriaWithCommentBoxes || 0}/${assignmentData.rubric.length} comentarios`
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
    return 'free';
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
      inputRate ? `input ${formatCostAmount(inputRate.value, currency)}` : '',
      outputRate ? `output ${formatCostAmount(outputRate.value, currency)}` : '',
    ]
      .filter(Boolean)
      .join(' / ')
      .concat(` per ${costUnit}`);
  }

  const flatAmount = pricing.amount ?? pricing.value ?? pricing.rate;
  if (flatAmount !== undefined && flatAmount !== null && flatAmount !== '') {
    return `${formatCostAmount(flatAmount, currency)}${unit ? ` per ${unit}` : ''}`;
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
};

const refreshAiRuntimeStatus = async () => {
  const revision = ++aiStatusRevision;
  try {
    addPanelDiagnostic('ai.status.start');
    const response = await sendBackgroundMessage({ type: 'mca.getAiRuntimeStatus' });
    if (!response?.ok) {
      throw new Error(response?.error || 'No se ha podido leer el estado de la IA.');
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

const saveAiRuntimeSelection = async (providerChanged) => {
  const { provider, model } = getPanelElements();
  const config = {
    ...(provider.value ? { provider: provider.value } : {}),
    ...(model.value && !providerChanged ? { model: model.value } : {}),
  };

  if (providerChanged) {
    const stored = await chrome.storage.local.get('mca.aiProviderConfigs');
    const profile = stored['mca.aiProviderConfigs']?.[provider.value];
    config.baseUrl = profile?.baseUrl || MoodliaCorrectorAiProviders[provider.value].baseUrl;
    config.model = profile?.model || '';
  }

  const response = await sendBackgroundMessage({
    type: 'mca.setAiRuntimeConfig',
    config,
  });

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
  setPanelStatus(MoodliaCorrectorI18n.t('Configuración de IA guardada.'));
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

  try {
    addPanelDiagnostic('correction.pageAi.start');
    const result = await requestAiCorrectionFromPage(assignmentForCorrection);
    if (revision !== gradingPageRevision) return;
    currentCorrection = result;
    updateExtraFilesSummary();
    renderCorrectionResult(currentCorrection);
    correction.value = JSON.stringify(currentCorrection.parsed || currentCorrection.text, null, 2);
    const applyResult = await applyCorrectionWhenReady(currentCorrection);
    if (revision !== gradingPageRevision) return;
    setPanelStatus(
      MoodliaCorrectorI18n.t('Corrección aplicada en Moodle. Revisa la nota y los comentarios antes de guardar.'),
    );
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
    setPanelStatus(`JSON inválido: ${message}`);
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
    setPanelStatus(
      MoodliaCorrectorI18n.t('Corrección aplicada en Moodle. Revisa la nota y los comentarios antes de guardar.'),
    );
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

const resetAssistantForNavigation = (refresh = true) => {
  gradingPageRevision++;
  if (panelConnectionTestId) { void sendBackgroundMessage({ type: 'mca.cancelCorrection', requestId: panelConnectionTestId }).catch(() => {}); panelConnectionTestId = null; getPanelElements().panel.querySelector('[data-runtime-options]').textContent = MoodliaCorrectorI18n.t('Probar conexión'); }
  if (settingsFrame) { settingsFrame.contentWindow.postMessage({ type: 'mca.cancelSettingsTest', token: new URL(settingsFrame.src).searchParams.get('token') }, '*'); settingsFrame.remove(); settingsFrame = null; }
  void setAiSettingsMode('simple');
  savedInstructionsReady = instructionsController.setContext(isSupportedGraderUrl() ? getInstructionContext() : {});
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
    panelRefreshTimer = setTimeout(() => {
      void refreshPanelData().catch((error) => {
        if (revision === gradingPageRevision) setPanelStatus(error.message);
      });
    }, 300);
  }
};

const watchGradingNavigation = () => {
  let identity = getNavigationIdentity();
  let active = false;
  let checkTimer = null;
  let propertyTimer = null;
  const host = document.getElementById(PANEL_ID);
  const scalarIdentity = () => JSON.stringify([location.href,
    document.querySelector('input[name="userid"]')?.value || '',
    document.querySelector('input[name="attemptnumber"]')?.value || '',
    document.body.className.match(/\bcourse-(\d+)\b/)?.[1] || '']);
  let scalar = scalarIdentity();
  const stop = () => {
    active = false;
    clearTimeout(checkTimer);
    checkTimer = null;
    clearInterval(propertyTimer);
    propertyTimer = null;
    observer.disconnect();
    host.dataset.navigationWatch = 'stopped';
  };
  const check = () => {
    checkTimer = null;
    if (!isSupportedGraderUrl()) {
      stop();
      identity = '';
      resetAssistantForNavigation(false);
      return;
    }
    const next = getNavigationIdentity();
    scalar = scalarIdentity();
    if (next !== identity) { identity = next; resetAssistantForNavigation(); }
  };
  const schedule = () => {
    if (active && checkTimer === null) checkTimer = setTimeout(check, 100);
  };
  const observer = new MutationObserver(schedule);
  const start = () => {
    if (active || !isSupportedGraderUrl()) return;
    active = true;
    host.dataset.navigationWatch = 'active';
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
    // Only property changes lacking DOM/navigation events need a lightweight fallback.
    propertyTimer = setInterval(() => {
      const next = scalarIdentity();
      if (next !== scalar) { scalar = next; check(); }
    }, 1000);
  };
  const navigate = () => { if (isSupportedGraderUrl()) start(); check(); };
  window.addEventListener('popstate', navigate);
  window.addEventListener('hashchange', navigate);
  window.navigation?.addEventListener('currententrychange', navigate);
  window.addEventListener('pagehide', () => { stop(); identity = ''; resetAssistantForNavigation(false); });
  window.addEventListener('pageshow', event => { if (event.persisted) navigate(); });
  start();
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
          currentAssignmentData = assignmentData;
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
