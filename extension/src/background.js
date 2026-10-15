const APP_INFO = {
  id: 'moodle-correction-assistant',
  name: 'MoodlIA Corrector',
  version: '0.1.45',
};

const MOODLE_GRADER_PATH = '/mod/assign/view.php';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const AI_CONFIG_STORAGE_KEY = 'mca.aiConfig';
const AI_SECRET_STORAGE_KEY = 'mca.aiSecret';
const diagnostics = [];
let aiConfigCache = {};
let aiSecretCache = {};
const activeCorrections = new Map();
const AI_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 10_000;
let configWriteQueue = Promise.resolve();

const supportedAiProviders = new Set(['ollama', 'openai-compatible']);
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const normalizeAiBaseUrl = (baseUrl, provider = 'ollama') => {
  const fallback = provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1';
  const parsed = new URL(String(baseUrl || fallback).trim());

  if (parsed.protocol !== 'https:' && !(provider === 'ollama' && parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname))) {
    throw new Error('Use HTTPS for remote AI providers. Ollama may use localhost over HTTP.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The AI provider URL cannot include credentials, a query string, or a fragment.');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
};

const sanitizeAiConfig = (config = {}) => {
  const provider = supportedAiProviders.has(config?.provider) ? config.provider : 'ollama';
  return {
    provider,
    baseUrl: normalizeAiBaseUrl(config?.baseUrl, provider),
    model: String(config?.model || '').trim(),
  };
};

const sanitizeAiSecret = (config = {}) => ({
  ...(typeof config?.apiKey === 'string' && config.apiKey.trim() ? { apiKey: config.apiKey.trim() } : {}),
  ...(typeof config?.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {}),
});

const loadAiConfig = async () => {
  if (!chrome.storage?.local) {
    return aiConfigCache;
  }

  const stored = await chrome.storage.local.get(AI_CONFIG_STORAGE_KEY);
  aiConfigCache = sanitizeAiConfig(stored[AI_CONFIG_STORAGE_KEY] || aiConfigCache);
  return aiConfigCache;
};

const loadAiSecret = async () => {
  if (!chrome.storage?.session) {
    return aiSecretCache;
  }

  const stored = await chrome.storage.session.get(AI_SECRET_STORAGE_KEY);
  aiSecretCache = sanitizeAiSecret(stored[AI_SECRET_STORAGE_KEY] || {});
  return aiSecretCache;
};

const saveAiConfig = (config = {}) => {
  const write = configWriteQueue.catch(() => {}).then(async () => {
    const previous = await loadAiConfig();
    const patch = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    const next = sanitizeAiConfig({ ...previous, ...patch });
    const destinationChanged = previous.provider !== next.provider || previous.baseUrl !== next.baseUrl;
    // Clear secrets before changing destination, even if the subsequent write fails.
    if (destinationChanged || Object.hasOwn(patch, 'apiKey')) {
      aiSecretCache = sanitizeAiSecret({ ...patch, baseUrl: next.baseUrl });
      if (chrome.storage?.session) {
        await chrome.storage.session.set({ [AI_SECRET_STORAGE_KEY]: aiSecretCache });
      }
    }
    aiConfigCache = next;

    if (chrome.storage?.local) {
      await chrome.storage.local.set({
        [AI_CONFIG_STORAGE_KEY]: aiConfigCache,
      });
    }

    return aiConfigCache;
  });
  configWriteQueue = write;
  return write;
};

const loadBoundAiSecret = async (config) => {
  const secret = await loadAiSecret();
  return secret.baseUrl === config.baseUrl ? secret : {};
};

const fetchAiResource = async (url, init = {}, { signal, timeoutMs = AI_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason || new Error('AI request cancelled.'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  // Keep the MV3 worker alive while a local model loads or generates a response.
  const heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo?.().catch(() => {}); }, 20_000);
  try {
    await ensureLocalOllamaHeaders(url);
    const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      let error;
      try { error = JSON.parse(text)?.error; } catch { /* Use the HTTP status for non-JSON errors. */ }
      throw new Error(`AI request failed (HTTP ${response.status}): ${typeof error === 'string' ? error : error?.message || response.statusText || 'Provider error'}`);
    }
    return JSON.parse(text);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof SyntaxError) throw new Error('The AI provider returned an invalid JSON response.');
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', cancel);
  }
};

let localHeaderRule;
const ensureLocalOllamaHeaders = async (url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname) || !chrome.declarativeNetRequest) return;
  if (!localHeaderRule) {
    localHeaderRule = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [11434],
      addRules: [{
        id: 11434, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: {
          regexFilter: '^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?/',
          initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'],
        },
      }],
    }).catch((error) => { localHeaderRule = null; throw error; });
  }
  await localHeaderRule;
};

const isSupportedGraderPage = (url) =>
  url.pathname.endsWith(MOODLE_GRADER_PATH) && url.searchParams.get('action') === 'grader';

const isSupportedGraderUrl = (url = '') => {
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

const updateActionForTab = (tabId, url = '') => {
  if (!tabId || !chrome.action) {
    return;
  }

  const enabled = isSupportedGraderUrl(url);

  try {
    const actionResult = enabled ? chrome.action.enable(tabId) : chrome.action.disable(tabId);
    actionResult?.catch?.(() => {});
  } catch {
    // Enabling/disabling the action should not block the runtime.
  }

  chrome.action.setTitle({
    tabId,
    title: enabled
      ? 'MoodlIA Corrector'
      : 'MoodlIA Corrector only runs on Moodle assignment grader pages',
  });
};

const addDiagnostic = (stage, detail = {}) => {
  const entry = {
    time: new Date().toISOString(),
    stage,
    detail,
  };
  diagnostics.unshift(entry);
  diagnostics.splice(30);
  console.log('[MoodlIA Corrector]', stage, detail);
  return entry;
};

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

const buildCorrectionRepairPrompt = (assignmentData, invalidResponseText) => {
  const aiPayload = buildAiAssignmentPayload(assignmentData);
  const pageLanguage = getLanguageInstruction(assignmentData.page?.language);
  const expectedRubricSelections = buildRubricSelectionTemplate(assignmentData);
  const rubricLevelReference = buildRubricLevelReference(assignmentData);

  return [
    'The previous AI response did not match the required Moodle correction schema.',
    'Convert it into the required schema now.',
    `Write every human-facing text in ${pageLanguage}.`,
    'Return one valid JSON object only: no Markdown, disclaimers, extra text, duplicate keys, or extra top-level keys.',
    '',
    'Required JSON shape:',
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
    `Rubric requirement: return exactly ${expectedRubricSelections.length} rubricSelections item(s), using every criterionId from the template.`,
    'Each rubricSelections item must contain exactly criterionId, levelIndex, and criterionFeedback.',
    'levelIndex must be an integer from the Rubric level index reference below. Never return null.',
    'Do not add criterionIndex, reason, score, maxScore, levelId, or any other key inside rubricSelections.',
    'Do not copy levelIndex 0 for every criterion unless every criterion genuinely matches the first/lowest level.',
    'Use levelIndex from each criterion levels array. If evidence is insufficient, choose a conservative level and explain the limitation in criterionFeedback.',
    'Do not create generic criteria. Use only the Moodle rubric criteria in Assignment data.',
    '',
    'Rubric level index reference:',
    JSON.stringify(rubricLevelReference, null, 2),
    `maxScore must be exactly ${JSON.stringify(getExpectedMaxScore(assignmentData))}.`,
    hasNumericGradeControl(assignmentData)
      ? 'score may be numeric because Moodle exposes a numeric grade control.'
      : 'score must be null because Moodle does not expose a numeric grade control or maxScore is null.',
    'Do not invent submitted content that is not present in the Assignment data or attached file text.',
    'Forbidden top-level keys: assessment_type, subject, assignment_context, grading_suggestions, criteria_breakdown, suggested_revision_tasks.',
    '',
    'Invalid previous response:',
    String(invalidResponseText || '').slice(0, 12000),
    '',
    'Assignment data:',
    JSON.stringify(aiPayload, null, 2),
  ].join('\n');
};

const buildAiAssignmentPayload = (assignmentData) => {
  return {
    page: { language: assignmentData.page?.language || '' },
    assignmentTitle: assignmentData.assignmentTitle,
    assignmentDescription: {
      source: assignmentData.linkedAssignmentDescription?.text ? 'linked-description' : 'inline-page',
      text: assignmentData.linkedAssignmentDescription?.text || assignmentData.assignmentPrompt || '',
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
        mimeType: file.mimeType || '',
        sizeBytes: file.sizeBytes || null,
      })),
      extraFiles: (assignmentData.extraFiles || []).map((file) => ({
        id: file.id,
        mimeType: file.mimeType || '',
        sizeBytes: file.sizeBytes || null,
        source: file.source || 'manual-upload',
      })),
    },
  };
};

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

const normalizeMoodleAttachmentUrl = (fileUrl, pageUrl) => {
  const page = new URL(String(pageUrl || ''));
  const candidate = new URL(String(fileUrl || ''), page);
  if (page.protocol !== 'https:' || candidate.protocol !== 'https:' || candidate.origin !== page.origin) {
    throw new Error('Submitted files must use HTTPS and the Moodle page origin.');
  }
  if (candidate.username || candidate.password) {
    throw new Error('Submitted file URLs cannot include credentials.');
  }
  candidate.hash = '';
  return candidate.href;
};

const fetchSubmissionFileAttachments = async (submissionFiles = [], pageUrl, signal) => {
  const attachments = [];
  let totalBytes = 0;
  for (const [index, file] of submissionFiles.entries()) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Attachment download timed out.')), 30_000);
    try {
      const response = await fetch(normalizeMoodleAttachmentUrl(file.url, pageUrl), {
        credentials: 'include', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Attachment ${index + 1} could not be downloaded (HTTP ${response.status}).`);
      const blob = await response.blob();
      totalBytes += blob.size;
      if (blob.size > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new Error('Submission attachments exceed the 4 MB per file or 10 MB total limit.');
      }
      const attachment = { id: file.id, name: file.name, mimeType: blob.type || 'application/octet-stream', sizeBytes: blob.size };
      if (attachment.mimeType.startsWith('text/') || /\.(txt|csv|md|json|xml|html|css|js|ts|py|java|c|cpp|log)$/i.test(file.name)) {
        attachment.textContent = await blob.text();
      } else {
        attachment.base64Data = arrayBufferToBase64(await blob.arrayBuffer());
      }
      attachments.push(attachment);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return attachments;
};

const normalizeExtraFileAttachments = (extraFiles = []) => {
  const attachments = [];
  let totalBytes = 0;

  for (const [index, file] of extraFiles.entries()) {
    if (!file || typeof file !== 'object') {
      continue;
    }

    const sizeBytes = Number(file.sizeBytes || 0);
    totalBytes += sizeBytes;

    if (sizeBytes > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error('Extra attachments exceed the 4 MB per file or 10 MB total limit.');
    }

    const attachment = {
      id: file.id || `extra-file-${index + 1}`,
      name: file.name || `extra-file-${index + 1}`,
      mimeType: file.mimeType || 'application/octet-stream',
      sizeBytes,
    };

    if (typeof file.textContent === 'string') {
      attachment.textContent = file.textContent;
    } else if (typeof file.base64Data === 'string') {
      attachment.base64Data = file.base64Data;
    } else {
      throw new Error(`Extra attachment ${index + 1} has no readable content.`);
    }

    attachments.push(attachment);
  }

  addDiagnostic('attachments.extra.normalized', { count: attachments.length });
  return attachments;
};

const getDirectAiStatus = async () => {
  const config = await loadAiConfig();
  const secret = await loadBoundAiSecret(config);
  const requiresApiKey = config.provider === 'openai-compatible';
  const configured = Boolean(config.model) && (!requiresApiKey || Boolean(secret.apiKey));
  let models = [];
  let reachable = false;
  let reason = requiresApiKey && !secret.apiKey ? 'Add an API key for this server in Options.' : '';
  if (!reason) {
    try {
      const payload = await fetchAiResource(
        `${config.baseUrl}${config.provider === 'ollama' ? '/api/tags' : '/models'}`,
        { headers: secret.apiKey ? { Authorization: `Bearer ${secret.apiKey}` } : {} },
        { timeoutMs: STATUS_TIMEOUT_MS },
      );
      models = config.provider === 'ollama'
        ? (payload.models || []).map((item) => ({ id: item.name, name: item.name }))
        : (payload.data || []).map((item) => ({ id: item.id, name: item.id }));
      reachable = true;
      if (config.model && !models.some((item) => item.id === config.model)) {
        reason = 'The configured model is not listed by this server.';
      }
    } catch (error) { reason = error.message || String(error); }
  }
  const available = reachable && !reason && configured;
  return {
    appConfig: {
      ...config,
      configured,
      requiresApiKey,
      hasApiKey: Boolean(secret.apiKey),
      reachable,
      reason,
    },
    providers: [{ provider: config.provider, available, reachable, reason, supports: { chat: true }, models }],
  };
};

const formatDirectAttachments = (files = []) => {
  const textAttachments = files
    .filter((file) => typeof file?.textContent === 'string' && file.textContent.trim())
    .map((file, index) => `Attachment ${index + 1} (${file.mimeType || 'unknown type'})\n${file.textContent}`);
  return textAttachments.join('\n\n');
};

let offscreenCreation;
const ensureAttachmentReader = async () => {
  if (offscreenCreation) return offscreenCreation;
  offscreenCreation = (async () => {
    const path = 'src/attachments/reader.html';
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(path)] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: path, reasons: ['DOM_PARSER', 'WORKERS'], justification: 'Read PDF and DOCX submissions locally before grading.',
    });
  })();
  try { await offscreenCreation; } finally { offscreenCreation = null; }
};

const prepareDirectAttachments = async (files, signal) => {
  let totalBytes = 0;
  let totalText = 0;
  let imageCount = 0;
  const prepared = [];
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) throw signal.reason;
    totalBytes += file.sizeBytes || 0;
    if (file.sizeBytes > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Attachments exceed the 4 MB per file or 10 MB total limit.');
    let attachment = file;
    if (file.base64Data) {
      await ensureAttachmentReader();
      const response = await waitForAttachmentReader(chrome.runtime.sendMessage({ target: 'attachment-reader', type: 'mca.readAttachment', file }), signal);
      if (!response?.ok) throw new Error(`Attachment ${index + 1}: ${response?.error || 'Could not read file.'}`);
      attachment = { mimeType: file.mimeType, sizeBytes: file.sizeBytes, ...response.attachment };
    }
    if (!attachment.textContent?.trim() && !attachment.images?.length) throw new Error(`Attachment ${index + 1} has no readable content.`);
    totalText += attachment.textContent?.length || 0;
    imageCount += attachment.images?.length || 0;
    if (totalText > 60_000 || imageCount > 12) throw new Error('Attachments exceed the 60,000 text character or 12 image limit. Split the submission before correcting.');
    prepared.push(attachment);
  }
  return prepared;
};

const waitForAttachmentReader = (promise, signal) => new Promise((resolve, reject) => {
  const cancel = () => finish(reject, signal.reason || new Error('AI request cancelled.'));
  const timer = setTimeout(() => finish(reject, new Error('Local attachment extraction timed out.')), 60_000);
  const finish = (callback, value) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    callback(value);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
});

const testAiConnection = async (options = {}) => {
  const config = await loadAiConfig();
  const secret = await loadBoundAiSecret(config);
  const startedAt = Date.now();
  const response = await requestDirectChat(config, secret, [{ role: 'user', content: 'Connection test with fictional data only. Return exactly this JSON object: {"status":"ok"}.' }], options);
  if (parseJsonResponse(response.text)?.status !== 'ok') throw new Error('The provider responded but did not return the expected test JSON.');
  return { provider: response.provider, model: response.model, elapsedMs: Date.now() - startedAt };
};

const createDirectMessages = (assignmentData, files, repairText = '', provider = 'ollama') => {
  const prompt = repairText
    ? buildCorrectionRepairPrompt(assignmentData, repairText)
    : buildCorrectionPrompt(assignmentData);
  const attachmentContext = formatDirectAttachments(files);

  const images = files.flatMap((file) => file.images || []);
  const content = attachmentContext ? `${prompt}\n\nAttached text:\n${attachmentContext}` : prompt;
  return [
    {
      role: 'system',
      content: 'You are an educational assessment assistant. Produce a structured grading suggestion for a teacher to review.',
    },
    {
      role: 'user',
      content: provider === 'openai-compatible' && images.length
        ? [{ type: 'text', text: content }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64Data}` } }))]
        : content,
      ...(provider === 'ollama' && images.length ? { images: images.map((image) => image.base64Data) } : {}),
    },
  ];
};

const extractDirectAiText = (payload, provider) => {
  if (provider === 'ollama') {
    return String(payload?.message?.content || '').trim();
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || '').join('').trim();
  }
  return '';
};

const createDirectChatRequest = (config, secret, messages) => {
  if (!config.model) {
    throw new Error('Choose a model in MoodlIA Corrector settings before requesting a correction.');
  }

  const provider = config.provider;
  const endpoint = provider === 'ollama' ? `${config.baseUrl}/api/chat` : `${config.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (provider === 'ollama') {
    body = {
      model: config.model,
      messages,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
    };
  } else {
    if (!secret.apiKey) {
      throw new Error('Add an API key in MoodlIA Corrector settings before using an OpenAI-compatible provider.');
    }
    headers.Authorization = `Bearer ${secret.apiKey}`;
    body = {
      model: config.model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };
  }

  return { endpoint, headers, body };
};

const requestDirectChat = async (config, secret, messages, options = {}) => {
  const provider = config.provider;
  const request = createDirectChatRequest(config, secret, messages);
  const payload = await fetchAiResource(request.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: request.headers,
    body: JSON.stringify(request.body),
  }, options);

  const text = extractDirectAiText(payload, provider);
  if (!text) {
    throw new Error(`${provider} returned an empty correction.`);
  }

  return {
    text,
    usage: payload?.usage,
    provider,
    model: config.model,
  };
};

const requestDirectAiCorrection = async (assignmentData, options = {}) => {
  const config = await loadAiConfig();
  const secret = await loadBoundAiSecret(config);
  createDirectChatRequest(config, secret, []);
  const rawFiles = [
    ...(await fetchSubmissionFileAttachments(assignmentData.submissionFiles || [], assignmentData.page?.url, options.signal)),
    ...normalizeExtraFileAttachments(assignmentData.extraFiles || []),
  ];
  const files = await prepareDirectAttachments(rawFiles, options.signal);
  if (config.provider === 'ollama' && files.some((file) => file.images?.length)) {
    const modelInfo = await fetchAiResource(`${config.baseUrl}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model }),
    }, { ...options, timeoutMs: STATUS_TIMEOUT_MS });
    if (!modelInfo.capabilities?.includes('vision')) throw new Error('The selected Ollama model does not support images. Choose a vision model.');
  }

  addDiagnostic('directAi.correction.start', {
    provider: config.provider,
    model: config.model || null,
    attachments: files.length,
  });

  const response = await requestDirectChat(config, secret, createDirectMessages(assignmentData, files, '', config.provider), options);
  let parsed = parseCorrectionResponse(response.text, assignmentData);

  if (!isCorrectionComplete(parsed, assignmentData)) {
    try {
      const repair = await requestDirectChat(config, secret, createDirectMessages(assignmentData, files, response.text, config.provider), options);
      const repaired = parseCorrectionResponse(repair.text, assignmentData);
      if (isCorrectionComplete(repaired, assignmentData)) {
        parsed = repaired;
        response.text = repair.text;
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      addDiagnostic('directAi.correction.repairFailed', { message: error.message || String(error) });
    }
  }

  addDiagnostic('directAi.correction.done', {
    provider: response.provider,
    model: response.model,
    textLength: response.text.length,
    complete: isCorrectionComplete(parsed, assignmentData),
  });
  if (!isCorrectionComplete(parsed, assignmentData)) throw new Error('The AI returned an incomplete correction after retrying. No grades were applied.');
  return { ...response, parsed };
};

const requestAiCorrection = (assignmentData, options) => requestDirectAiCorrection(assignmentData, options);

const getAiRuntimeStatus = () => getDirectAiStatus();
const setAiRuntimeConfig = (config) => saveAiConfig(config || {});
const openAiRuntimeOptions = async () => {
  await chrome.runtime.openOptionsPage();
  return true;
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
  const rubricInputComplete = getRubricCriteriaWithLevels(assignmentData).every((criterion, index) => {
    const selection = findRubricSelectionForCriterion(rubricSelections, criterion, index);
    const level = selection.levelIndex ?? selection.level_index ?? selection.level;
    const feedback = selection.criterionFeedback || selection.finalFeedback || selection.feedback || selection.comment;
    return level !== null && level !== undefined && Number.isInteger(Number(level)) &&
      getValidRubricLevelIndexes(criterion).includes(Number(level)) &&
      (!selection.criterionId || selection.criterionId === criterion.id) && typeof feedback === 'string' && Boolean(feedback.trim());
  });
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
    needsRepair: !rubricInputComplete,
    studentFeedback,
    score: hasNumericGradeControl(assignmentData) && parsed.score !== null && parsed.score !== '' && parsed.score !== undefined && Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null,
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
    hasValidScore: !hasNumericGradeControl(assignmentData) || Number.isFinite(correction?.score) && correction.score >= 0 && (getExpectedMaxScore(assignmentData) === null || correction.score <= getExpectedMaxScore(assignmentData)),
    expectedRubricCount,
    actualRubricCount,
    hasCompleteRubric: expectedRubricCount === 0 || actualRubricCount >= expectedRubricCount,
  };
};

const isCorrectionComplete = (correction, assignmentData = {}) => {
  const completeness = getCorrectionCompleteness(correction, assignmentData);
  return completeness.hasSupportedSchema && completeness.hasStudentFeedback && completeness.hasCompleteRubric && completeness.hasValidScore;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'attachment-reader') return false;
  const requestKey = `${sender.tab?.id ?? 'extension'}:${message?.requestId || 'default'}`;
  if (message?.type === 'mca.cancelCorrection') {
    const controller = activeCorrections.get(requestKey);
    controller?.abort(new Error('AI request cancelled.'));
    sendResponse({ ok: true, cancelled: Boolean(controller) });
    return false;
  }
  if (message?.type === 'mca.testAiConnection') {
    if (activeCorrections.has(requestKey)) {
      sendResponse({ ok: false, error: 'A connection test is already running.' });
      return false;
    }
    const controller = new AbortController();
    activeCorrections.set(requestKey, controller);
    void testAiConnection({ signal: controller.signal })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
      .finally(() => activeCorrections.delete(requestKey));
    return true;
  }
  if (message?.type === 'mca.detectAiProxyBridge') {
    void getDirectAiStatus()
      .then((status) => sendResponse({ ok: true, extensionId: status.appConfig.configured ? 'direct-ai' : '' }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'mca.getDiagnostics') {
    sendResponse({ ok: true, diagnostics });
    return false;
  }

  if (message?.type === 'mca.getAiRuntimeStatus') {
    void getAiRuntimeStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'mca.setAiRuntimeConfig') {
    void setAiRuntimeConfig(message.config)
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'mca.openAiRuntimeOptions') {
    void openAiRuntimeOptions()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'mca.correctAssignment') {
    if (activeCorrections.has(requestKey)) {
      sendResponse({ ok: false, error: 'A correction is already running.' });
      return false;
    }
    const controller = new AbortController();
    activeCorrections.set(requestKey, controller);
    const timer = setTimeout(() => controller.abort(new Error('Correction timed out after 10 minutes.')), 600_000);
    void requestAiCorrection(message.assignmentData, { signal: controller.signal })
      .then((correction) => sendResponse({ ok: true, correction }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
      .finally(() => { clearTimeout(timer); activeCorrections.delete(requestKey); });
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateActionForTab(tabId, changeInfo.url || tab.url || '');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    const error = chrome.runtime.lastError;
    if (error) {
      return;
    }

    updateActionForTab(tabId, tab.url || '');
  });
});

chrome.tabs.query({}, (tabs) => {
  const error = chrome.runtime.lastError;
  if (error) {
    return;
  }

  tabs.forEach((tab) => updateActionForTab(tab.id, tab.url || ''));
});
