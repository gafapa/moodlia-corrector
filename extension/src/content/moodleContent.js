const MOODLE_ASSIGNMENT_PATH = '/mod/assign/';
const MOODLE_GRADER_PATH = '/mod/assign/view.php';
const ALLOWED_MOODLE_HOSTS = new Set(['platega.edu.xunta.gal']);
const PANEL_WIDTH = 420;
const FLOATING_BUTTON_ID = 'mca-floating-button-host';
const PANEL_ID = 'mca-side-panel-host';
const PAGE_STYLE_ID = 'mca-page-layout-style';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const APP_INFO = {
  id: 'moodle-correction-assistant',
  name: 'Moodle Correction Assistant',
  version: '0.1.41',
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

const isAllowedMoodleDomain = (url) => ALLOWED_MOODLE_HOSTS.has(url.hostname);

const isSupportedGraderPage = (url) =>
  url.pathname === MOODLE_GRADER_PATH && url.searchParams.get('action') === 'grader';

const isSupportedGraderUrl = (url = window.location.href) => {
  try {
    const currentUrl = new URL(url);
    return (
      currentUrl.protocol === 'https:' &&
      isAllowedMoodleDomain(currentUrl) &&
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

  return element.innerText.replace(/\s+/g, ' ').trim();
};

const getVisibleTextWithoutAssistant = (element) => {
  if (!element) {
    return '';
  }

  const clone = element.cloneNode(true);
  clone.querySelectorAll(`#${FLOATING_BUTTON_ID}, #${PANEL_ID}`).forEach((node) => node.remove());
  return getVisibleText(clone);
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
    })
    .filter((file) => {
      const key = `${file.name}|${file.url}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

const getFileExtension = (fileName) => {
  const cleanName = String(fileName || '').split('?')[0].trim();
  const match = cleanName.match(/(\.[a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : '';
};

const readBlobAsBase64 = async (blob) => {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

const fetchSubmissionFileAttachments = async (submissionFiles) => {
  const attachments = [];
  let totalBytes = 0;

  addPanelDiagnostic('attachments.fetch.start', { count: submissionFiles.length });

  for (const file of submissionFiles) {
    if (totalBytes >= MAX_TOTAL_ATTACHMENT_BYTES) {
      addPanelDiagnostic('attachments.fetch.totalLimit', { totalBytes });
      break;
    }

    try {
      const response = await fetch(file.url, { credentials: 'include' });
      if (!response.ok) {
        addPanelDiagnostic('attachments.fetch.httpError', { id: file.id, status: response.status });
        attachments.push({
          id: file.id,
          name: file.name,
          mimeType: 'text/plain',
          sizeBytes: 0,
          textContent: `Could not fetch submitted file ${file.name}: HTTP ${response.status}.`,
        });
        continue;
      }

      const blob = await response.blob();
      totalBytes += blob.size;

      if (blob.size > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        addPanelDiagnostic('attachments.fetch.skippedLarge', {
          id: file.id,
          sizeBytes: blob.size,
          totalBytes,
        });
        attachments.push({
          id: file.id,
          name: file.name,
          mimeType: 'text/plain',
          sizeBytes: blob.size,
          textContent: `Submitted file ${file.name} was detected but skipped because it is too large.`,
        });
        continue;
      }

      const mimeType = blob.type || 'application/octet-stream';
      const attachment = {
        id: file.id,
        name: file.name,
        mimeType,
        sizeBytes: blob.size,
      };

      if (mimeType.startsWith('text/') || /\.(txt|csv|md|json|xml|html|css|js|ts|py|java|c|cpp)$/i.test(file.name)) {
        attachment.textContent = await blob.text();
      } else {
        attachment.base64Data = await readBlobAsBase64(blob);
      }

      attachments.push(attachment);
      addPanelDiagnostic('attachments.fetch.ok', {
        id: file.id,
        name: file.name,
        mimeType,
        sizeBytes: blob.size,
      });
    } catch (error) {
      const message = error.message || String(error);
      addPanelDiagnostic('attachments.fetch.error', { id: file.id, message });
      attachments.push({
        id: file.id,
        name: file.name,
        mimeType: 'text/plain',
        sizeBytes: 0,
        textContent: `Could not fetch submitted file ${file.name}: ${message}`,
      });
    }
  }

  addPanelDiagnostic('attachments.fetch.done', { count: attachments.length });
  return attachments;
};


const extractOnlineText = () => {
  return findFirstText([
    '.assignsubmission_onlinetext',
    '[class*="assignsubmission_onlinetext"]',
    '[id*="assignsubmission_onlinetext"]',
    '.submissiontext',
  ]);
};

const toAbsoluteUrl = (url) => {
  try {
    return new URL(url, location.href).href;
  } catch {
    return '';
  }
};

const isSameOriginUrl = (url) => {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
};

const extractAssignmentDescriptionLink = () => {
  const links = [...document.querySelectorAll('a[href]')];
  const candidates = links
    .map((link) => {
      const url = toAbsoluteUrl(link.getAttribute('href'));
      const text = getVisibleText(link);
      const title = link.getAttribute('title') || '';
      const label = `${text} ${title}`.trim();
      let score = 0;

      if (!url || url === location.href || !isSameOriginUrl(url)) {
        return null;
      }

      if (/\/mod\/assign\/view\.php/i.test(url)) {
        score += 6;
      }

      if (/[?&]id=\d+/i.test(url)) {
        score += 1;
      }

      if (/descripci[o\u00f3]n|description|enunciado|instrucciones|assignment|tarea/i.test(label)) {
        score += 8;
      }

      if (/grade|calificar|corregir|user|attempt|download|pluginfile/i.test(url)) {
        score -= 5;
      }

      return score > 0
        ? {
            label: text || title || url,
            url,
            score,
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  const best = candidates[0];
  return best ? { label: best.label, url: best.url } : null;
};

const extractDescriptionFromDocument = (doc) => {
  const selectors = [
    '#intro',
    '.activity-description',
    '.activity-information',
    '.box.generalbox',
    '[role="main"] .generalbox',
    '[role="main"]',
  ];

  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    const text = getVisibleText(element);
    if (text && text.length > 40) {
      return text.slice(0, 12000);
    }
  }

  return '';
};

const fetchAssignmentDescription = async (descriptionLink) => {
  if (!descriptionLink?.url || !isSameOriginUrl(descriptionLink.url)) {
    return null;
  }

  try {
    const response = await fetch(descriptionLink.url, {
      credentials: 'include',
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
    const title = getVisibleText(doc.querySelector('h1, .page-header-headings h1')) || descriptionLink.label;

    return {
      ...descriptionLink,
      title,
      text: extractDescriptionFromDocument(doc),
    };
  } catch (error) {
    return {
      ...descriptionLink,
      text: '',
      error: error.message || String(error),
    };
  }
};

const getPageContext = () => ({
  title: document.title,
  url: location.href,
  language: document.documentElement.lang || document.documentElement.getAttribute('xml:lang') || navigator.language || '',
  detectedAsMoodleAssignment: location.pathname.includes(MOODLE_ASSIGNMENT_PATH),
});

const extractMaxScore = () => {
  const gradeInputs = [
    ...document.querySelectorAll('input[name*="grade" i], input[id*="grade" i]'),
  ];

  for (const input of gradeInputs) {
    const max = input.getAttribute('max');
    if (max && Number.isFinite(Number(max))) {
      return Number(max);
    }
  }

  const bodyText = getVisibleTextWithoutAssistant(document.body);
  const match = bodyText.match(/(?:grade|score|nota|puntuaci[o\u00f3]n)\D{0,20}(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/i);
  if (match?.[2]) {
    return Number(match[2].replace(',', '.'));
  }

  return null;
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
    type: 'manual',
    rubric: [],
    guide: [],
  };
};

const extractSubmissionText = () => {
  const onlineText = extractOnlineText();
  if (onlineText) {
    return onlineText.slice(0, 12000);
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
  const descriptionLink = extractAssignmentDescriptionLink();
  const linkedDescription = await fetchAssignmentDescription(descriptionLink);
  const submissionFiles = extractSubmissionFiles();
  const correctionMethod = extractCorrectionMethod();
  const finalFeedbackBox = findCommentBox();
  const gradeInput = findGradeInput();
  const rubric = correctionMethod.rubric;
  const inlinePrompt = findFirstText([
    '#intro',
    '.activity-description',
    '.intro',
    '[role="main"] .generalbox',
  ]);

  return {
    page: getPageContext(),
    courseName: extractCourseName(),
    studentName: extractStudentName(),
    assignmentTitle: findFirstText(['h1', '.page-header-headings h1', '.activityname']),
    assignmentDescriptionLink: descriptionLink,
    linkedAssignmentDescription: linkedDescription,
    assignmentPrompt: linkedDescription?.text || inlinePrompt,
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
  return document.querySelector(
    'input[name*="grade" i]:not([type="hidden"]), input[id*="grade" i]:not([type="hidden"])',
  );
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

const findCriterionElement = (criterionId, fallbackIndex = -1) => {
  if (criterionId) {
    const byId = document.getElementById(criterionId);
    if (byId) {
      return byId;
    }

    for (const criterion of getRubricCriterionElements()) {
      if (
        criterion.dataset.mcaCriterionId === criterionId ||
        criterion.getAttribute('data-criterion-id') === criterionId ||
        criterion.querySelector('input[name*="criterion" i]')?.name === criterionId
      ) {
        return criterion;
      }
    }
  }

  const criteria = getRubricCriterionElements();

  return fallbackIndex >= 0 ? criteria[fallbackIndex] || null : null;
};

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

const getRubricCriterionDefinition = (selection = {}, selectionIndex = 0) => {
  const rubric = currentAssignmentData?.rubric || [];
  const criterionId = selection?.criterionId;

  return (
    rubric.find((criterion) => criterion.id === criterionId) ||
    rubric[Number(selection?.criterionIndex)] ||
    rubric[selectionIndex] ||
    null
  );
};

const getRubricLevelDefinition = (criterionDefinition = null, levelIndex = -1) => {
  if (!criterionDefinition || !Number.isInteger(levelIndex)) {
    return null;
  }

  return (
    (criterionDefinition.levels || []).find((level) => Number(level?.index) === levelIndex) ||
    criterionDefinition.levels?.[levelIndex] ||
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
    let levelIndex = Number(selection?.levelIndex ?? selection?.level_index ?? selection?.level);
    const misplacedLevelIndex = Number(selection?.criterionIndex);
    if (!Number.isInteger(levelIndex) && criterionId && Number.isInteger(misplacedLevelIndex)) {
      levelIndex = misplacedLevelIndex;
    }
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

    const criterionDefinition = getRubricCriterionDefinition(selection, selectionIndex);
    const criterionFallbackIndex = criterionDefinition
      ? (currentAssignmentData?.rubric || []).indexOf(criterionDefinition)
      : selectionIndex;
    const criterion = findCriterionElement(criterionId, criterionFallbackIndex);
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
  const parsed = normalizeCorrectionResponse(parsedInput, currentAssignmentData || {}) || parsedInput;
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
  return applyCorrection(correction);
};

const sendBackgroundMessage = (message) => chrome.runtime.sendMessage(message);

const createRequestId = () => crypto.randomUUID();

const buildAiAssignmentPayload = (assignmentData) => ({
  page: assignmentData.page,
  courseName: assignmentData.courseName,
  studentName: assignmentData.studentName,
  assignmentTitle: assignmentData.assignmentTitle,
  assignmentDescription: {
    source: assignmentData.linkedAssignmentDescription?.text ? 'linked-description' : 'inline-page',
    text: assignmentData.assignmentPrompt || '',
  },
  correctionMethod: assignmentData.correctionMethod || 'manual',
  extraInstructions: assignmentData.extraInstructions || '',
  maxScore: assignmentData.maxScore,
  gradingControls: assignmentData.gradingControls || {},
  rubric: assignmentData.rubric || [],
  gradingGuide: assignmentData.gradingGuide || [],
  submission: {
    onlineText: assignmentData.submissionText || '',
    files: (assignmentData.submissionFiles || []).map((file) => ({
      id: file.id,
      name: file.name,
    })),
    extraFiles: (assignmentData.extraFiles || []).map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType || '',
      sizeBytes: file.sizeBytes || null,
      source: file.source || 'manual-upload',
    })),
  },
});

const getLanguageInstruction = (languageCode = '') => {
  const normalized = String(languageCode || '').toLowerCase();
  const languageMap = {
    gl: 'Galician (galego)',
    'gl-es': 'Galician (galego)',
    es: 'Spanish (español)',
    'es-es': 'Spanish (español)',
    en: 'English',
    'en-us': 'English',
    'en-gb': 'English',
  };

  return languageMap[normalized] || languageCode || 'the Moodle page language';
};

const getRubricCriteriaWithLevels = (assignmentData = {}) =>
  (assignmentData.rubric || []).filter(
    (criterion) =>
      Array.isArray(criterion.levels) &&
      criterion.levels.length > 0 &&
      !/-levels(?:-|$)/i.test(criterion.id || '') &&
      !/-description-cell$/i.test(criterion.id || '') &&
      criterion.controls?.levelSelection !== false,
  );

const getExpectedMaxScore = (assignmentData = {}) => assignmentData.maxScore ?? null;

const hasNumericGradeControl = (assignmentData = {}) =>
  Boolean(assignmentData.gradingControls?.grade) && getExpectedMaxScore(assignmentData) !== null;

const getScoreTemplate = (assignmentData = {}) => (hasNumericGradeControl(assignmentData) ? 7.5 : null);

const buildRubricSelectionTemplate = (assignmentData = {}) => {
  const rubricCriteria = getRubricCriteriaWithLevels(assignmentData);

  if (rubricCriteria.length === 0) {
    return [];
  }

  return rubricCriteria.map((criterion, criterionIndex) => ({
    criterionId: criterion.id,
    levelIndex: null,
    criterionFeedback: `Feedback for criterion ${criterionIndex + 1}, in the Moodle page language.`,
  }));
};

const buildRubricLevelReference = (assignmentData = {}) =>
  getRubricCriteriaWithLevels(assignmentData).map((criterion) => ({
    criterionId: criterion.id,
    description: criterion.description,
    allowedLevels: (criterion.levels || []).map((level, fallbackIndex) => ({
      levelIndex: Number(level?.index ?? fallbackIndex),
      score: level?.score ?? null,
      description: level?.text || '',
    })),
  }));

const buildCorrectionPrompt = (assignmentData) => {
  const aiPayload = buildAiAssignmentPayload(assignmentData);
  const pageLanguage = getLanguageInstruction(assignmentData.page?.language);
  const expectedRubricSelections = buildRubricSelectionTemplate(assignmentData);
  const rubricLevelReference = buildRubricLevelReference(assignmentData);

  return [
    'You are an educational assessment assistant helping a teacher grade a Moodle assignment.',
    `Write every human-facing string value in the Moodle page language: ${pageLanguage}.`,
    'Return one valid JSON object only: no Markdown, prose, disclaimers, duplicate keys, templates, headings, bullet lists, placeholders, or extra top-level keys.',
    '',
    'Return this exact JSON shape:',
    JSON.stringify(
      {
        studentFeedback: 'Final feedback addressed to the student, in the Moodle page language.',
        score: getScoreTemplate(assignmentData),
        maxScore: getExpectedMaxScore(assignmentData),
        rubricSelections: expectedRubricSelections,
      },
      null,
      2,
    ),
    '',
    'Evidence rules:',
    '- Be fair, compact, specific, evidence-based, and aligned with the Moodle rubric.',
    '- Base the decision only on the assignment statement, online text, inspectable submitted file content, and correction method.',
    '- Also follow the teacher additional instructions when provided, unless they conflict with the Moodle rubric, assignment evidence, or the schema.',
    '- If submitted file content is missing or cannot be inspected, do not invent its title, topic, AI tool, prompts, methodology, activities, adaptations, conclusions, or student identity from file names.',
    '- When evidence is missing or unverifiable, state the limitation in studentFeedback and affected criterionFeedback, then choose a conservative level.',
    '',
    'Score rules:',
    `- maxScore must be exactly ${JSON.stringify(getExpectedMaxScore(assignmentData))}. Do not infer or invent another maximum.`,
    hasNumericGradeControl(assignmentData)
      ? '- score may be numeric because Moodle exposes a numeric grade control.'
      : '- score must be null because Moodle does not expose a numeric grade control or maxScore is null.',
    '',
    'Rubric rules:',
    `- The detected rubric has ${expectedRubricSelections.length} criterion item(s) with levels. Return exactly ${expectedRubricSelections.length} rubricSelections item(s).`,
    '- Every rubricSelections item must contain exactly these three keys: criterionId, levelIndex, and criterionFeedback.',
    '- Use every criterionId from the template above exactly as written.',
    '- The template levelIndex is null only as a placeholder. Never return null.',
    '- For each criterion, choose exactly one levelIndex from the Rubric level index reference below.',
    '- Choose each levelIndex independently from the evidence and the level descriptions. Do not copy the first level by default.',
    '- Returning levelIndex 0 for every criterion is invalid unless the evidence genuinely matches the first/lowest level for every criterion.',
    '- The first visible level is levelIndex 0, the next is 1, and so on.',
    '- Never add criterionIndex, reason, score, maxScore, levelId, or any other key inside rubricSelections.',
    '- Use the Moodle rubric criteria only. Choose one level per criterion and include criterionFeedback for every criterion.',
    '- criterionFeedback must explain briefly why that level was selected and mention the most relevant evidence.',
    '',
    'Rubric level index reference:',
    JSON.stringify(rubricLevelReference, null, 2),
    '',
    'Language and feedback rules:',
    '- studentFeedback must be the final overall feedback for the Moodle feedback comments box.',
    '- studentFeedback must be constructive, concise, and ready to send to the student.',
    '- Do not use Spanish or mixed-language forms when the Moodle page language is Galician.',
    '- Keep property names in English exactly as shown.',
    '- Forbidden top-level keys: assessment_type, subject, assignment_context, grading_suggestions, criteria_breakdown, suggested_revision_tasks.',
    '',
    'Assignment data:',
    JSON.stringify(aiPayload, null, 2),
  ].join('\n');
};

const parseJsonResponse = (text) => {
  const trimmed = String(text || '').trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const stripMarkdownForFeedback = (text) =>
  String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/\*\*\*/g, '')
    .replace(/^#+\s+/gm, '')
    .trim();

const buildFallbackCorrection = (text, assignmentData = {}) => {
  const feedback = stripMarkdownForFeedback(text).slice(0, 12000);

  return {
    needsRepair: true,
    studentFeedback: feedback || 'AI did not return a usable correction.',
    score: null,
    maxScore: getExpectedMaxScore(assignmentData),
    rubricSelections: buildFallbackRubricSelections(assignmentData, feedback),
  };
};

const buildFallbackRubricFeedback = (assignmentData = {}, criterionIndex = 0, baseFeedback = '') => {
  const pageLanguage = getLanguageInstruction(assignmentData.page?.language);
  const prefix =
    pageLanguage.includes('Galician')
      ? 'Non foi posible obter unha valoración específica deste criterio coa resposta da IA. Revise a entrega e axuste este nivel se é necesario.'
      : pageLanguage.includes('Spanish')
        ? 'No fue posible obtener una valoración específica de este criterio con la respuesta de la IA. Revise la entrega y ajuste este nivel si es necesario.'
        : 'The AI response did not provide a specific assessment for this criterion. Review the submission and adjust this level if needed.';
  const shortFeedback = stripMarkdownForFeedback(baseFeedback).slice(0, 500);

  return shortFeedback ? `${prefix} ${shortFeedback}` : `${prefix} Criterio ${criterionIndex + 1}.`;
};

const buildFallbackRubricSelections = (assignmentData = {}, baseFeedback = '') =>
  getRubricCriteriaWithLevels(assignmentData).map((criterion, criterionIndex) => ({
    criterionId: criterion.id,
    levelIndex: 0,
    criterionFeedback: buildFallbackRubricFeedback(assignmentData, criterionIndex, baseFeedback),
  }));

const getValidRubricLevelIndexes = (criterion = {}) =>
  (criterion.levels || [])
    .map((level, fallbackIndex) => Number(level?.index ?? fallbackIndex))
    .filter((levelIndex) => Number.isInteger(levelIndex));

const normalizeRubricLevelIndex = (criterion = {}, selection = {}, options = {}) => {
  const validLevelIndexes = getValidRubricLevelIndexes(criterion);
  const fallbackLevelIndex = validLevelIndexes[0] ?? 0;
  const explicitLevelIndex = Number(selection?.levelIndex ?? selection?.level_index ?? selection?.level);
  if (Number.isInteger(explicitLevelIndex)) {
    return validLevelIndexes.includes(explicitLevelIndex) ? explicitLevelIndex : fallbackLevelIndex;
  }

  const misplacedLevelIndex = Number(selection?.criterionIndex);
  if (options.allowCriterionIndexAsLevel && validLevelIndexes.includes(misplacedLevelIndex)) {
    return misplacedLevelIndex;
  }

  return fallbackLevelIndex;
};

const normalizeComparableText = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const getSelectionCriterionNumber = (selection = {}) => {
  const rawNumber =
    selection.criterionNumber ??
    selection.criterion_number ??
    selection.number ??
    selection.order ??
    null;
  if (rawNumber === null || rawNumber === undefined || rawNumber === '') {
    return null;
  }
  const criterionNumber = Number(rawNumber);
  return Number.isInteger(criterionNumber) ? criterionNumber : null;
};

const getSelectionCriterionIndex = (selection = {}) => {
  const rawIndex = selection.criterionIndex ?? selection.criterion_index ?? selection.index ?? null;
  if (rawIndex === null || rawIndex === undefined || rawIndex === '') {
    return null;
  }
  const criterionIndex = Number(rawIndex);
  return Number.isInteger(criterionIndex) ? criterionIndex : null;
};

const getSelectionCriterionText = (selection = {}) =>
  normalizeComparableText(
    selection.criterion ||
      selection.criterionName ||
      selection.criterionTitle ||
      selection.criterionDescription ||
      selection.description ||
      selection.title ||
      '',
  );

const findRubricSelectionForCriterion = (rubricSelections = [], criterion = {}, criterionIndex = 0) => {
  const selectionById = rubricSelections.find((selection) => selection?.criterionId === criterion.id);
  if (selectionById) {
    return selectionById;
  }

  const selectionByNumber = rubricSelections.find((selection) => {
    const criterionNumber = getSelectionCriterionNumber(selection);
    const explicitCriterionIndex = getSelectionCriterionIndex(selection);
    return criterionNumber === criterionIndex + 1 || explicitCriterionIndex === criterionIndex;
  });
  if (selectionByNumber) {
    return selectionByNumber;
  }

  const criterionText = normalizeComparableText(criterion.description);
  const selectionByText = criterionText
    ? rubricSelections.find((selection) => {
        const selectionText = getSelectionCriterionText(selection);
        return selectionText && (criterionText.includes(selectionText) || selectionText.includes(criterionText));
      })
    : null;
  if (selectionByText) {
    return selectionByText;
  }

  return rubricSelections[criterionIndex] || {};
};

const normalizeRubricSelections = (assignmentData = {}, rubricSelections = [], baseFeedback = '') => {
  const expectedCriteria = getRubricCriteriaWithLevels(assignmentData);
  const fallbackSelections = buildFallbackRubricSelections(assignmentData, baseFeedback);

  return expectedCriteria.map((criterion, criterionIndex) => {
    const matchingSelection = findRubricSelectionForCriterion(rubricSelections, criterion, criterionIndex);
    const matchedById = matchingSelection?.criterionId === criterion.id;
    const fallbackSelection = fallbackSelections[criterionIndex] || {};

    return {
      criterionId: criterion.id,
      levelIndex: normalizeRubricLevelIndex(criterion, matchingSelection, {
        allowCriterionIndexAsLevel: matchedById,
      }),
      criterionFeedback:
        matchingSelection.criterionFeedback ||
        matchingSelection.finalFeedback ||
        matchingSelection.feedback ||
        matchingSelection.comment ||
        fallbackSelection.criterionFeedback ||
        '',
    };
  });
};

const getFinalComment = (parsed = {}) =>
  parsed.finalComment ||
  parsed.finalFeedback ||
  parsed.studentFeedback ||
  parsed.feedback ||
  parsed.overallFeedback ||
  parsed.overall_feedback ||
  '';

const getRubricSelectionsInput = (parsed = {}) => {
  const candidates = [
    parsed.rubricSelections,
    parsed.criteria,
    parsed.criterionSelections,
    parsed.criteriaSelections,
    parsed.rubric,
  ];
  return candidates.find((candidate) => Array.isArray(candidate)) || [];
};

const getForeignSchemaFeedback = (parsed) => {
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }

  return (
    getFinalComment(parsed) ||
    parsed.grading_suggestions?.overall_feedback ||
    parsed.grading_suggestions?.summary ||
    parsed.assignment_context ||
    ''
  );
};

const normalizeCorrectionResponse = (parsed, assignmentData = {}) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const studentFeedback = getFinalComment(parsed);
  const rubricSelections = getRubricSelectionsInput(parsed);
  const hasExpectedShape =
    Object.prototype.hasOwnProperty.call(parsed, 'finalComment') ||
    Object.prototype.hasOwnProperty.call(parsed, 'finalFeedback') ||
    Object.prototype.hasOwnProperty.call(parsed, 'studentFeedback') ||
    Object.prototype.hasOwnProperty.call(parsed, 'score') ||
    Object.prototype.hasOwnProperty.call(parsed, 'rubricSelections') ||
    Object.prototype.hasOwnProperty.call(parsed, 'criteria');

  if (!hasExpectedShape) {
    const foreignFeedback = getForeignSchemaFeedback(parsed);
    if (!foreignFeedback) {
      return null;
    }

    return {
      needsRepair: true,
      studentFeedback: foreignFeedback,
      score: null,
      maxScore: getExpectedMaxScore(assignmentData),
      rubricSelections: buildFallbackRubricSelections(assignmentData, foreignFeedback),
    };
  }

  return {
    needsRepair: false,
    studentFeedback,
    score: hasNumericGradeControl(assignmentData) && Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null,
    maxScore: getExpectedMaxScore(assignmentData),
    rubricSelections: normalizeRubricSelections(assignmentData, rubricSelections, studentFeedback),
  };
};

const parseCorrectionResponse = (text, assignmentData = {}) =>
  normalizeCorrectionResponse(parseJsonResponse(text), assignmentData) || buildFallbackCorrection(text, assignmentData);

const getCorrectionCompleteness = (correction, assignmentData = {}) => {
  const expectedRubricCount = getRubricCriteriaWithLevels(assignmentData).length;
  const actualRubricCount = Array.isArray(correction?.rubricSelections) ? correction.rubricSelections.length : 0;

  return {
    hasStudentFeedback: Boolean(correction?.studentFeedback?.trim?.()),
    hasSupportedSchema: correction?.needsRepair !== true,
    expectedRubricCount,
    actualRubricCount,
    hasCompleteRubric: expectedRubricCount === 0 || actualRubricCount >= expectedRubricCount,
  };
};

const connectPageAiRuntime = (extensionId) => {
  addPanelDiagnostic('pageAi.connect.start', { extensionId });
  const port = chrome.runtime.connect(extensionId, { name: 'ai-runtime-v1' });
  const pending = new Map();
  const chats = new Map();
  let disconnected = false;

  const postToPort = (message, stage) => {
    if (disconnected) {
      return false;
    }

    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      addPanelDiagnostic('pageAi.postMessage.error', {
        stage,
        message: error.message || String(error),
      });
      return false;
    }
  };

  port.onMessage.addListener((message) => {
    if (message?.type === 'runtime.error' && !message.requestId) {
      const error = new Error(message.error?.message || 'AI runtime request failed.');
      addPanelDiagnostic('pageAi.error', { error: message.error || null });

      for (const deferred of pending.values()) {
        deferred.reject(error);
      }
      pending.clear();

      for (const chat of chats.values()) {
        chat.reject(error);
      }
      chats.clear();
      return;
    }

    if (!message?.requestId) {
      return;
    }

    const chat = chats.get(message.requestId);
    if (chat) {
      if (message.type === 'runtime.chat.heartbeat') {
        chat.heartbeatCount += 1;
        if (chat.heartbeatCount === 1 || chat.heartbeatCount % 6 === 0) {
          addPanelDiagnostic('pageAi.chat.heartbeat', {
            requestId: message.requestId,
            count: chat.heartbeatCount,
          });
        }
        return;
      }

      if (message.type === 'runtime.chat.started') {
        chat.provider = message.provider;
        chat.model = message.model;
        addPanelDiagnostic('pageAi.chat.started', {
          requestId: message.requestId,
          provider: message.provider,
          model: message.model,
        });
        return;
      }

      if (message.type === 'runtime.chat.delta') {
        chat.text += message.delta || '';
        return;
      }

      if (message.type === 'runtime.chat.done') {
        chats.delete(message.requestId);
        addPanelDiagnostic('pageAi.chat.done', { requestId: message.requestId });
        chat.resolve({
          provider: chat.provider,
          model: chat.model,
          text: chat.text,
          usage: message.usage,
        });
        return;
      }

      if (message.type === 'runtime.chat.error' || message.type === 'runtime.error') {
        chats.delete(message.requestId);
        addPanelDiagnostic('pageAi.chat.error', {
          requestId: message.requestId,
          error: message.error || null,
        });
        chat.reject(new Error(message.error?.message || JSON.stringify(message.error) || 'AI request failed.'));
        return;
      }
    }

    const deferred = pending.get(message.requestId);
    if (!deferred) {
      return;
    }

    pending.delete(message.requestId);
    if (message.type === 'runtime.error' || message.type === 'runtime.chat.error') {
      deferred.reject(new Error(message.error?.message || JSON.stringify(message.error) || 'AI runtime request failed.'));
      return;
    }

    deferred.resolve(message);
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    const message = chrome.runtime.lastError?.message || 'AI Runtime disconnected.';
    addPanelDiagnostic('pageAi.disconnect', { message });
    for (const deferred of pending.values()) {
      deferred.reject(new Error(message));
    }
    pending.clear();
    for (const chat of chats.values()) {
      chat.reject(new Error(message));
    }
    chats.clear();
  });

  const sendRequest = (message, timeoutMs = 30_000) => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(message.requestId);
        reject(new Error('AI runtime request timed out.'));
      }, timeoutMs);

      pending.set(message.requestId, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      if (!postToPort(message, message.type)) {
        pending.delete(message.requestId);
        clearTimeout(timeoutId);
        reject(new Error('AI Runtime disconnected.'));
      }
    });
  };

  const chat = (message) => {
    return new Promise((resolve, reject) => {
      chats.set(message.requestId, {
        resolve: (value) => {
          resolve(value);
        },
        reject: (error) => {
          reject(error);
        },
        text: '',
        provider: message.provider,
        model: message.model,
        heartbeatCount: 0,
      });

      if (!postToPort(message, message.type)) {
        chats.delete(message.requestId);
        reject(new Error('AI Runtime disconnected.'));
      }
    });
  };

  return {
    sendRequest,
    chat,
    disconnect: () => {
      if (!disconnected) {
        disconnected = true;
        port.disconnect();
      }
    },
  };
};

const selectPageAiRoute = (capabilities, appConfig = {}) => {
  const availableProviders = (capabilities.providers || []).filter(
    (provider) => provider.available && provider.supports?.chat,
  );
  const provider = availableProviders.find((candidate) => candidate.provider === 'ollama') || null;

  if (!provider) {
    throw new Error('AI Runtime has no available Ollama chat provider.');
  }

  return {
    provider: provider.provider,
    ...(appConfig.provider === 'ollama' && appConfig.model
      ? { model: appConfig.model }
      : {}),
  };
};

const requestAiCorrectionFromPage = async (assignmentData) => {
  const response = await sendBackgroundMessage({
    type: 'mca.correctAssignment',
    assignmentData,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'La corrección con IA ha fallado.');
  }

  return response.correction;
};

const createTextBlock = (text, emptyText = 'No detectado') => {
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
    ['Curso', assignmentData.courseName || 'No detectado'],
    ['Tarea', assignmentData.assignmentTitle || 'No detectada'],
    ['Alumno/a', assignmentData.studentName || 'No detectado'],
    ['Corrección', assignmentData.correctionMethod || 'manual'],
    [
      'Descripción',
      assignmentData.assignmentDescriptionLink?.url
        ? assignmentData.assignmentDescriptionLink.url
        : 'No detectada',
    ],
    ['Puntuación máxima', assignmentData.maxScore ?? 'No detectada'],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = String(value);
    row.append(term, description);
    taskList.appendChild(row);
  });

  addSection('Contexto de la tarea', taskList);
  const controlsList = document.createElement('dl');
  controlsList.className = 'compact-list';
  const gradingControls = assignmentData.gradingControls || {};
  [
    [
      'Niveles de rúbrica',
      assignmentData.rubric.length
        ? `${gradingControls.rubricCriteriaWithLevelControls || 0} de ${assignmentData.rubric.length} criterios se pueden seleccionar`
        : 'No se han detectado controles de rúbrica',
    ],
    [
      'Comentarios por criterio',
      assignmentData.rubric.length
        ? `${gradingControls.rubricCriteriaWithCommentBoxes || 0} de ${assignmentData.rubric.length} cajas de comentario detectadas`
        : 'No se han detectado comentarios por criterio',
    ],
    [
      'Comentario final',
      gradingControls.finalFeedback ? `Detectado (${gradingControls.finalFeedbackType})` : 'No detectado',
    ],
    ['Campo de nota', gradingControls.grade ? `Detectado (${gradingControls.gradeType})` : 'No detectado'],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    controlsList.appendChild(row);
  });
  addSection('Controles de corrección', controlsList);
  addSection(
    assignmentData.linkedAssignmentDescription?.text ? 'Descripción enlazada de la tarea' : 'Instrucciones',
    assignmentData.assignmentPrompt ||
      assignmentData.linkedAssignmentDescription?.error ||
      'No detectado',
  );
  addSection(
    'Texto de entrega en línea',
    assignmentData.submissionText || 'No se ha detectado texto de entrega en línea.',
  );

  const files = document.createElement('ul');
  files.className = 'plain-list';
  if (assignmentData.submissionFiles.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'No se han detectado archivos entregados.';
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
  addSection('Archivos entregados', files);

  const rubric = document.createElement('div');
  rubric.className = 'rubric-list';
  if (assignmentData.rubric.length === 0) {
    rubric.appendChild(createTextBlock('', 'No se ha detectado rúbrica.'));
  } else {
    for (const criterion of assignmentData.rubric) {
      const item = document.createElement('details');
      item.className = 'rubric-item';
      const title = document.createElement('summary');
      title.textContent = criterion.description || criterion.id;
      const controls = document.createElement('p');
      controls.textContent = `Niveles: ${criterion.controls?.levelSelection ? 'seleccionables' : 'no seleccionables'} · Comentario: ${
        criterion.controls?.criterionComment ? `detectado (${criterion.controls.criterionCommentType})` : 'no detectado'
      }`;
      const levels = document.createElement('ol');
      levels.className = 'level-list';

      if (criterion.levels.length === 0) {
        const level = document.createElement('li');
        level.textContent = 'No se han detectado niveles.';
        levels.appendChild(level);
      } else {
        for (const levelData of criterion.levels) {
          const level = document.createElement('li');
          const status = levelData.selectable ? 'seleccionable' : 'detectado';
          level.textContent = `${levelData.text || `Nivel ${levelData.index + 1}`} (${status})`;
          levels.appendChild(level);
        }
      }

      item.append(title, controls, levels);
      rubric.appendChild(item);
    }
  }
  addSection('Rúbrica', rubric);

  if (assignmentData.gradingGuide?.length > 0) {
    const guide = document.createElement('div');
    guide.className = 'rubric-list';

    for (const criterion of assignmentData.gradingGuide) {
      const item = document.createElement('details');
      item.className = 'rubric-item';
      const title = document.createElement('summary');
      title.textContent = criterion.description || criterion.id;
      const score = document.createElement('p');
      score.textContent = criterion.maxScore ? `Puntuación máxima: ${criterion.maxScore}` : 'No se ha detectado puntuación';
      item.append(title, score);
      guide.appendChild(item);
    }

    addSection('Guía de evaluación', guide);
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
      width: ${PANEL_WIDTH}px;
      max-width: calc(100vw - 40px);
      height: 100vh;
      background: #f4f6f9;
      border-left: 1px solid #d5dbe7;
      box-shadow: none;
      transform: translateX(100%);
      transition: transform 180ms ease;
    }

    .panel[data-open="true"] {
      transform: translateX(0);
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
      grid-template-columns: 78px 1fr;
      gap: 8px;
      align-items: center;
    }

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
    html.mca-panel-open,
    html.mca-panel-open body {
      overflow-x: hidden !important;
    }

    html.mca-panel-open body {
      width: calc(100vw - ${PANEL_WIDTH}px) !important;
      max-width: calc(100vw - ${PANEL_WIDTH}px) !important;
    }

    html.mca-panel-open #page,
    html.mca-panel-open #page-wrapper,
    html.mca-panel-open .drawer-toggles,
    html.mca-panel-open [data-region="drawer"] {
      max-width: calc(100vw - ${PANEL_WIDTH}px) !important;
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
  button.title = 'Abrir Corrector de Moodle';
  button.setAttribute('aria-label', 'Abrir Corrector de Moodle');
  button.innerHTML = ICON_SVG;
  button.addEventListener('click', openPanel);

  shadow.appendChild(button);
  document.documentElement.appendChild(host);
};

const createCardHeading = (stepNumber, title, description) => {
  const heading = document.createElement('div');
  heading.className = 'card-heading';

  const badge = document.createElement('span');
  badge.className = 'step-number';
  badge.textContent = stepNumber;

  const text = document.createElement('div');
  const titleElement = document.createElement('h3');
  const descriptionElement = document.createElement('p');
  titleElement.textContent = title;
  descriptionElement.textContent = description;
  text.append(titleElement, descriptionElement);

  heading.append(badge, text);
  return heading;
};

const promoteWorkflowSection = (section, className, heading) => {
  section.className = className;
  section.querySelector('.section-title')?.remove();
  section.prepend(heading);
  return section;
};

const createNestedSupervisionSection = (title, contentElement) => {
  const section = document.createElement('details');
  section.className = 'summary-card nested-disclosure';

  const summary = document.createElement('summary');
  summary.textContent = title;
  section.append(summary, contentElement);
  return section;
};

const organizePanelWorkflow = (panel) => {
  const content = panel.querySelector('.content');
  const sections = [...content.querySelectorAll(':scope > .section')];
  const [externalJsonSection, runtimeSection, diagnosticsSection, detectedSection, instructionsSection, assignmentSection, correctionSection] =
    sections;

  if (
    !externalJsonSection ||
    !runtimeSection ||
    !diagnosticsSection ||
    !detectedSection ||
    !instructionsSection ||
    !assignmentSection ||
    !correctionSection
  ) {
    return;
  }

  const workflow = document.createElement('div');
  workflow.className = 'workflow';

  promoteWorkflowSection(
    externalJsonSection,
    'workflow-card primary',
    createCardHeading('0', 'Pega o revisa JSON', 'Aplica una corrección generada fuera de la extensión o revisa la que cree la IA.'),
  );
  promoteWorkflowSection(
    runtimeSection,
    'workflow-card',
    createCardHeading('1', 'Configura la IA', 'Elige proveedor y modelo antes de lanzar la corrección.'),
  );
  promoteWorkflowSection(
    instructionsSection,
    'workflow-card',
    createCardHeading('2', 'Añade criterio docente', 'Opcional: indicaciones y archivos que complementan la entrega.'),
  );
  promoteWorkflowSection(
    correctionSection,
    'workflow-card',
    createCardHeading('3', 'Resultado editable', 'La respuesta generada por la IA queda visible para revisar.'),
  );

  const supervision = document.createElement('details');
  supervision.className = 'supervision';
  const supervisionSummary = document.createElement('summary');
  supervisionSummary.textContent = 'Supervisión de datos capturados';
  const supervisionNote = document.createElement('span');
  supervisionNote.className = 'supervision-note';
  supervisionNote.textContent = 'Solo para comprobar qué ha leído la extensión de Moodle.';
  supervisionSummary.appendChild(supervisionNote);

  const supervisionBody = document.createElement('div');
  supervisionBody.className = 'supervision-body';
  supervisionBody.append(
    createNestedSupervisionSection('Resumen detectado', detectedSection.querySelector('[data-detected-list]')),
    createNestedSupervisionSection('Información capturada de Moodle', assignmentSection.querySelector('[data-assignment]')),
    createNestedSupervisionSection('Diagnóstico técnico', diagnosticsSection.querySelector('[data-diagnostics]')),
  );

  supervision.append(supervisionSummary, supervisionBody);
  workflow.append(externalJsonSection, runtimeSection, instructionsSection, correctionSection, supervision);
  content.replaceChildren(workflow);
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
          <p class="runtime-state" data-runtime-state>Comprobando la IA...</p>
          <div class="runtime-row">
            <label for="mca-provider">Proveedor</label>
            <select id="mca-provider" data-provider></select>
          </div>
          <div class="runtime-row">
            <label for="mca-model">Modelo</label>
            <select id="mca-model" data-model></select>
          </div>
          <p class="runtime-cost" data-runtime-cost hidden></p>
          <div class="runtime-actions">
            <button class="action-button secondary" type="button" data-runtime-refresh>Actualizar IA</button>
            <button class="action-button secondary" type="button" data-runtime-options>Opciones</button>
          </div>
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
          <label for="mca-extra-instructions">Instrucciones para esta corrección</label>
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
    </footer>
  `;

  organizePanelWorkflow(panel);

  panel.querySelector('[data-close]').addEventListener('click', closePanel);
  panel.querySelector('[data-correct]').addEventListener('click', () => void requestCorrectionFromPanel());
  panel.querySelector('[data-apply-correction]').addEventListener('click', () => void applyCorrectionFromPanel());
  panel.querySelector('[data-runtime-refresh]').addEventListener('click', () => void refreshAiRuntimeStatus());
  panel.querySelector('[data-runtime-options]').addEventListener('click', () => void openAiRuntimeOptions());
  panel.querySelector('[data-provider]').addEventListener('change', () => void saveAiRuntimeSelection(true));
  panel.querySelector('[data-model]').addEventListener('change', () => void saveAiRuntimeSelection(false));
  panel.querySelector('[data-extra-files]').addEventListener('change', () => updateExtraFilesSummary());

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
    detectedList: root.querySelector('[data-detected-list]'),
    assignment: root.querySelector('[data-assignment]'),
    externalCorrection: root.querySelector('[data-external-correction]'),
    correction: root.querySelector('[data-correction]'),
    correctButton: root.querySelector('[data-correct]'),
    applyCorrectionButton: root.querySelector('[data-apply-correction]'),
    extraInstructions: root.querySelector('[data-extra-instructions]'),
    extraFiles: root.querySelector('[data-extra-files]'),
    extraFilesSummary: root.querySelector('[data-extra-files-summary]'),
    provider: root.querySelector('[data-provider]'),
    model: root.querySelector('[data-model]'),
    runtimeState: root.querySelector('[data-runtime-state]'),
    runtimeCost: root.querySelector('[data-runtime-cost]'),
    diagnostics: root.querySelector('[data-diagnostics]'),
  };
};

const setPanelStatus = (message) => {
  getPanelElements().status.textContent = message;
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
  const { extraFiles, extraFilesSummary } = getPanelElements();
  const files = [...(extraFiles?.files || [])];

  if (files.length === 0) {
    extraFilesSummary.textContent = 'Sin archivos adicionales.';
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  extraFilesSummary.textContent = `${files.length} archivo(s) adicional(es), ${(totalBytes / 1024 / 1024).toFixed(2)} MB.`;
};

const isTextAttachment = (file) =>
  file.type.startsWith('text/') || /\.(txt|csv|md|json|xml|html|css|js|ts|py|java|c|cpp|log)$/i.test(file.name);

const readExtraFilesFromPanel = async () => {
  const { extraFiles, extraFilesSummary } = getPanelElements();
  const selectedFiles = [...(extraFiles?.files || [])];
  const attachments = [];
  let totalBytes = 0;

  for (const [index, file] of selectedFiles.entries()) {
    totalBytes += file.size;

    if (file.size > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      attachments.push({
        id: `extra-file-${index + 1}`,
        name: file.name,
        mimeType: 'text/plain',
        sizeBytes: file.size,
        source: 'manual-upload',
        textContent: `El archivo adicional "${file.name}" se ha detectado, pero no se ha enviado porque supera el límite de tamaño.`,
      });
      continue;
    }

    const attachment = {
      id: `extra-file-${index + 1}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      source: 'manual-upload',
    };

    if (isTextAttachment(file)) {
      attachment.textContent = await file.text();
    } else {
      attachment.base64Data = await readBlobAsBase64(file);
    }

    attachments.push(attachment);
  }

  if (attachments.length > 0) {
    extraFilesSummary.textContent = `${attachments.length} archivo(s) preparado(s) para la IA.`;
  }

  return attachments;
};

const buildPanelAssignmentData = async () => {
  const { extraInstructions } = getPanelElements();
  const extraFiles = await readExtraFilesFromPanel();

  return {
    ...currentAssignmentData,
    extraInstructions: extraInstructions?.value?.trim() || '',
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
  void refreshPanelData();
  void refreshAiRuntimeStatus();
  void refreshDiagnostics();
};

const closePanel = () => {
  const { panel } = getPanelElements();
  panel.dataset.open = 'false';
  setPageShift(false);
};

const updateDetectedList = (assignmentData) => {
  const { detectedList } = getPanelElements();
  const gradingControls = assignmentData.gradingControls || {};
  const entries = [
    ['Tarea Moodle', assignmentData.page.detectedAsMoodleAssignment ? 'Sí' : 'No'],
    ['Título', assignmentData.assignmentTitle || 'No detectado'],
    [
      'Descripción',
      assignmentData.assignmentDescriptionLink?.url
        ? assignmentData.linkedAssignmentDescription?.text
          ? 'Enlace y contenido recuperados'
          : 'Enlace detectado'
        : 'No detectada',
    ],
    ['Instrucciones', assignmentData.assignmentPrompt ? `${assignmentData.assignmentPrompt.length} caracteres` : 'No detectadas'],
    ['Texto en línea', assignmentData.submissionText ? `${assignmentData.submissionText.length} caracteres` : 'No detectado'],
    ['Archivos', `${assignmentData.submissionFiles.length} archivo(s)`],
    ['Rúbrica', `${assignmentData.rubric.length} criterio(s)`],
    [
      'Controles de rúbrica',
      assignmentData.rubric.length
        ? `${gradingControls.rubricCriteriaWithLevelControls || 0}/${assignmentData.rubric.length} controles de nivel, ${gradingControls.rubricCriteriaWithCommentBoxes || 0}/${assignmentData.rubric.length} comentarios`
        : 'No detectados',
    ],
    [
      'Comentario final',
      gradingControls.finalFeedback
        ? `Detectado (${gradingControls.finalFeedbackType})`
        : 'No detectado',
    ],
    ['Guía', `${assignmentData.gradingGuide.length} criterio(s)`],
    ['Puntuación máxima', assignmentData.maxScore ?? 'No detectada'],
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
  setPanelStatus('Detectando datos de Moodle...');
  addPanelDiagnostic('extract.start');
  const gradingPanelReady = await waitForGradingPanelReady();
  addPanelDiagnostic('extract.gradePanelReady', { ready: gradingPanelReady });
  currentAssignmentData = await extractAssignmentData();

  const { assignment, correction } = getPanelElements();
  updateDetectedList(currentAssignmentData);
  renderAssignmentSummary(assignment, currentAssignmentData);

  if (!currentCorrection) {
    correction.value = '';
  }

  setPanelStatus('Datos detectados listos.');
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
    provider.append(new Option('IA no disponible', ''));
    model.append(new Option('Sin modelos', ''));
    provider.disabled = true;
    model.disabled = true;
    runtimeState.textContent = 'No se ha detectado la IA o no ha devuelto capacidades.';
    return;
  }

  const availableProviders = aiRuntimeStatus.providers.filter((item) => item.available);
  provider.disabled = availableProviders.length === 0;
  provider.append(new Option('Automático', ''));

  for (const item of availableProviders) {
    provider.append(new Option(createOptionLabelWithCost(item.provider, getAiCostText(item)), item.provider));
  }

  provider.value = aiRuntimeStatus.appConfig?.provider || '';
  const selectedProvider = availableProviders.find((item) => item.provider === provider.value);
  const models = selectedProvider?.models || [];

  model.disabled = !provider.value || models.length === 0;
  model.append(new Option(provider.value ? 'Modelo predeterminado' : 'Selecciona proveedor', ''));

  for (const modelInfo of models) {
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
    runtimeCost.textContent = `Coste: ${selectedCost}`;
    runtimeCost.hidden = false;
  }
  runtimeState.textContent =
    availableProviders.length > 0
      ? `Listo. ${availableProviders.length} proveedor(es) disponible(s).`
      : 'La IA está autorizada, pero no hay proveedores disponibles.';
};

const refreshAiRuntimeStatus = async () => {
  try {
    addPanelDiagnostic('ai.status.start');
    const response = await sendBackgroundMessage({ type: 'mca.getAiRuntimeStatus' });
    if (!response?.ok) {
      throw new Error(response?.error || 'No se ha podido leer el estado de la IA.');
    }

    aiRuntimeStatus = response.status;
    renderAiRuntimeControls();
    addPanelDiagnostic('ai.status.ok', {
      providers: response.status.providers?.length || 0,
      extension: response.status.extension?.id || null,
    });
    void refreshDiagnostics();
  } catch (error) {
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
    provider: provider.value || undefined,
    model: provider.value && model.value && !providerChanged ? model.value : undefined,
  };

  const response = await sendBackgroundMessage({
    type: 'mca.setAiRuntimeConfig',
    config,
  });

  if (!response?.ok) {
    setPanelStatus(response?.error || 'No se ha podido guardar la configuración de IA.');
    return;
  }

  aiRuntimeStatus = {
    ...aiRuntimeStatus,
    appConfig: response.config,
  };
  renderAiRuntimeControls();
  await refreshAiRuntimeStatus();
  setPanelStatus('Configuración de IA guardada.');
};

const openAiRuntimeOptions = async () => {
  const response = await sendBackgroundMessage({ type: 'mca.openAiRuntimeOptions' });
  if (!response?.ok) {
    setPanelStatus(response?.error || 'No se han podido abrir las opciones de IA.');
  }
};

const requestCorrectionFromPanel = async () => {
  if (!currentAssignmentData) {
    await refreshPanelData();
  }

  const { correction, correctButton } = getPanelElements();
  const assignmentForCorrection = await buildPanelAssignmentData();
  setPanelStatus('Solicitando corrección a la IA...');
  addPanelDiagnostic('correction.click', {
    files: assignmentForCorrection.submissionFiles.length,
    extraFiles: assignmentForCorrection.extraFiles.length,
    hasExtraInstructions: Boolean(assignmentForCorrection.extraInstructions),
    rubricCriteria: assignmentForCorrection.rubric.length,
  });
  correctButton.disabled = true;

  try {
    addPanelDiagnostic('correction.pageAi.start');
    currentCorrection = await requestAiCorrectionFromPage(assignmentForCorrection);
    correction.value = JSON.stringify(currentCorrection.parsed || currentCorrection.text, null, 2);
    const applyResult = await applyCorrectionWhenReady(currentCorrection);
    setPanelStatus(
      `Corrección aplicada (${currentCorrection.provider}/${currentCorrection.model}): comentario=${applyResult.commentApplied}, nota=${applyResult.gradeApplied}, niveles=${applyResult.rubricLevelsApplied}, comentarios=${applyResult.rubricCommentsApplied}.`,
    );
    addPanelDiagnostic('correction.ok', {
      provider: currentCorrection.provider,
      model: currentCorrection.model,
      parsed: Boolean(currentCorrection.parsed),
      applied: applyResult,
    });
  } catch (error) {
    const message = error.message || String(error);
    setPanelStatus(message);
    addPanelDiagnostic('correction.error', { message });
  } finally {
    correctButton.disabled = false;
  }
};

const applyCorrectionFromPanel = async () => {
  if (!currentAssignmentData) {
    await refreshPanelData();
  }

  const { externalCorrection, correction, applyCorrectionButton } = getPanelElements();
  const editedValue = externalCorrection.value.trim() || correction.value.trim();

  if (!editedValue) {
    setPanelStatus('Pega un JSON de corrección antes de aplicarlo.');
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
    currentCorrection = correctionToApply;
    setPanelStatus(
      `Aplicado: comentario=${result.commentApplied}, nota=${result.gradeApplied}, niveles=${result.rubricLevelsApplied}, comentarios=${result.rubricCommentsApplied}.`,
    );
    addPanelDiagnostic('manualCorrection.applied', result);
  } finally {
    applyCorrectionButton.disabled = false;
  }
};

const initializeAssistantUi = () => {
  createFloatingButton();
  createSidePanel();
};

if (isSupportedGraderUrl()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'mca.extractAssignment') {
      void extractAssignmentData()
        .then((assignmentData) => sendResponse({ ok: true, assignmentData }))
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
          message.assignmentData?.rubric?.length ? message.assignmentData : extractAssignmentData(),
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
