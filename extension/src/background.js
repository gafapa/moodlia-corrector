const APP_INFO = {
  id: 'moodle-correction-assistant',
  name: 'Moodle Correction Assistant',
  version: '0.1.41',
};

const createRequestId = () => crypto.randomUUID();
const AI_RUNTIME_EXTENSION_NAMES = ['AI Runtime', 'AI Proxy Bridge'];
const ALLOWED_MOODLE_HOSTS = new Set(['platega.edu.xunta.gal']);
const MOODLE_GRADER_PATH = '/mod/assign/view.php';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CHAT_START_TIMEOUT_MS = 30_000;
const LOCAL_CHAT_START_TIMEOUT_MS = 180_000;
const AI_RUNTIME_CONFIG_STORAGE_KEY = 'mca.aiRuntimeConfig';
const diagnostics = [];
let aiRuntimeAppConfigCache = {};

const sanitizeAiRuntimeConfig = (config = {}) => ({
  ...(config?.provider ? { provider: config.provider } : {}),
  ...(config?.model ? { model: config.model } : {}),
});

const loadAiRuntimeConfig = async () => {
  if (!chrome.storage?.local) {
    return aiRuntimeAppConfigCache;
  }

  const stored = await chrome.storage.local.get(AI_RUNTIME_CONFIG_STORAGE_KEY);
  aiRuntimeAppConfigCache = sanitizeAiRuntimeConfig(stored[AI_RUNTIME_CONFIG_STORAGE_KEY] || aiRuntimeAppConfigCache);
  return aiRuntimeAppConfigCache;
};

const saveAiRuntimeConfig = async (config = {}) => {
  aiRuntimeAppConfigCache = sanitizeAiRuntimeConfig(config);

  if (chrome.storage?.local) {
    await chrome.storage.local.set({
      [AI_RUNTIME_CONFIG_STORAGE_KEY]: aiRuntimeAppConfigCache,
    });
  }

  return aiRuntimeAppConfigCache;
};

const isAllowedMoodleDomain = (url) => ALLOWED_MOODLE_HOSTS.has(url.hostname);

const isSupportedGraderPage = (url) =>
  url.pathname === MOODLE_GRADER_PATH && url.searchParams.get('action') === 'grader';

const isSupportedGraderUrl = (url = '') => {
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
      ? 'Moodle Correction Assistant'
      : 'Moodle Correction Assistant only runs on Moodle grader pages',
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
  console.log('[Moodle Correction Assistant]', stage, detail);
  return entry;
};

const getInstalledExtensions = () => {
  return new Promise((resolve, reject) => {
    chrome.management.getAll((extensions) => {
      const error = chrome.runtime.lastError;
      if (error) {
        addDiagnostic('management.getAll.error', { message: error.message });
        reject(new Error(error.message));
        return;
      }

      addDiagnostic('management.getAll.ok', { count: extensions.length });
      resolve(extensions);
    });
  });
};

const openTab = (url) => {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tab);
    });
  });
};

const getAiExtensionId = async () => {
  const extensions = await getInstalledExtensions();
  const aiRuntime = extensions.find((extensionInfo) => {
    const name = extensionInfo.name || '';
    const description = extensionInfo.description || '';

    return (
      extensionInfo.enabled &&
      (AI_RUNTIME_EXTENSION_NAMES.some((extensionName) => name === extensionName || name.includes(extensionName)) ||
        description.includes('Local AI provider runtime') ||
        description.includes('Local AI provider gateway'))
    );
  });

  addDiagnostic('aiExtension.lookup', {
    found: Boolean(aiRuntime),
    id: aiRuntime?.id || null,
    name: aiRuntime?.name || null,
  });

  return aiRuntime?.id || '';
};

const getAiExtensionInfo = async () => {
  const extensions = await getInstalledExtensions();
  return (
    extensions.find((extensionInfo) => {
      const name = extensionInfo.name || '';
      const description = extensionInfo.description || '';

      return (
        extensionInfo.enabled &&
        (AI_RUNTIME_EXTENSION_NAMES.some((extensionName) => name === extensionName || name.includes(extensionName)) ||
          description.includes('Local AI provider runtime') ||
          description.includes('Local AI provider gateway'))
      );
    }) || null
  );
};

const sendAiRuntimeCall = (extensionId, payload, timeoutMs = 0) => {
  const requestId = createRequestId();
  const payloadRequestId = payload.requestId || requestId;
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  addDiagnostic('aiRuntime.call.post', {
    requestId,
    payloadRequestId,
    payloadType: payload.type,
    extensionId,
    timeoutMs: hasTimeout ? timeoutMs : null,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = hasTimeout
      ? setTimeout(() => {
          settled = true;
          reject(new Error('AI Runtime call timed out.'));
        }, timeoutMs)
      : null;

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback(value);
    };

    chrome.runtime.sendMessage(
      extensionId,
      {
        type: 'runtime.call',
        requestId,
        app: APP_INFO,
        payload: {
          ...payload,
          requestId: payloadRequestId,
        },
      },
      (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          addDiagnostic('aiRuntime.call.lastError', {
            requestId,
            payloadType: payload.type,
            message: error.message,
          });
          settle(reject, new Error(error.message));
          return;
        }

        addDiagnostic('aiRuntime.call.response', {
          requestId,
          payloadType: payload.type,
          responseType: response?.type || null,
          hasError: Boolean(response?.error),
        });

        if (!response || response.type === 'runtime.error' || response.type === 'runtime.chat.error' || response.error) {
          settle(reject, new Error(response?.error?.message || 'AI Runtime call failed.'));
          return;
        }

        settle(resolve, response);
      },
    );
  });
};

const connectAiRuntime = async (extensionId) => {
  let port;

  try {
    addDiagnostic('aiRuntime.connect.start', { extensionId });
    port = chrome.runtime.connect(extensionId, { name: 'ai-runtime-v1' });
  } catch {
    addDiagnostic('aiRuntime.connect.throw', { extensionId });
    throw new Error('AI Runtime extension is not installed or the ID is invalid.');
  }

  const pending = new Map();
  const streaming = new Map();
  let disconnected = false;

  const postToPort = (message, stage) => {
    if (disconnected) {
      return false;
    }

    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      addDiagnostic('aiRuntime.postMessage.error', {
        stage,
        message: error.message || String(error),
      });
      return false;
    }
  };

  port.onMessage.addListener((message) => {
    if (message?.type === 'runtime.error' && !message.requestId) {
      const error = new Error(message.error?.message || 'AI Runtime request failed.');
      addDiagnostic('aiRuntime.error', {
        requestId: null,
        type: message.type,
        error: message.error || null,
      });

      for (const deferred of pending.values()) {
        deferred.reject(error);
      }
      pending.clear();

      for (const stream of streaming.values()) {
        stream.reject(error);
      }
      streaming.clear();
      return;
    }

    if (!message?.requestId) {
      return;
    }

    if (message.type === 'runtime.chat.heartbeat') {
      const stream = streaming.get(message.requestId);
      if (stream) {
        stream.heartbeatCount += 1;
        if (stream.heartbeatCount === 1 || stream.heartbeatCount % 6 === 0) {
          addDiagnostic('aiRuntime.chat.heartbeat', {
            requestId: message.requestId,
            count: stream.heartbeatCount,
          });
        }
      }
      return;
    }

    if (message.type === 'runtime.chat.started') {
      addDiagnostic('aiRuntime.chat.started', {
        requestId: message.requestId,
        provider: message.provider,
        model: message.model,
      });
      const stream = streaming.get(message.requestId);
      if (stream) {
        stream.markStarted?.();
        stream.provider = message.provider;
        stream.model = message.model;
      }
      return;
    }

    if (message.type === 'runtime.chat.delta') {
      const stream = streaming.get(message.requestId);
      if (stream) {
        stream.text += message.delta || '';
      }
      return;
    }

    if (message.type === 'runtime.chat.done') {
      addDiagnostic('aiRuntime.chat.done', {
        requestId: message.requestId,
        usage: message.usage || null,
      });
      const stream = streaming.get(message.requestId);
      if (stream) {
        streaming.delete(message.requestId);
        stream.resolve({
          type: 'runtime.chat.result',
          requestId: message.requestId,
          provider: stream.provider,
          model: stream.model,
          text: stream.text,
          usage: message.usage,
        });
      }
      return;
    }

    if (message.type === 'runtime.error' || message.type === 'runtime.chat.error') {
      addDiagnostic('aiRuntime.error', {
        requestId: message.requestId,
        type: message.type,
        error: message.error || null,
      });
      const stream = streaming.get(message.requestId);
      if (stream) {
        streaming.delete(message.requestId);
        stream.reject(new Error(message.error?.message || JSON.stringify(message.error) || 'AI Runtime request failed.'));
        return;
      }
    }

    const deferred = pending.get(message.requestId);
    if (deferred) {
      pending.delete(message.requestId);
      if (message.type === 'runtime.error') {
        deferred.reject(new Error(message.error?.message || 'AI Runtime request failed.'));
      } else {
        deferred.resolve(message);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    const error = new Error(chrome.runtime.lastError?.message || 'AI Runtime disconnected.');
    addDiagnostic('aiRuntime.disconnect', { message: error.message });

    for (const deferred of pending.values()) {
      deferred.reject(error);
    }
    pending.clear();

    for (const stream of streaming.values()) {
      stream.reject(error);
    }
    streaming.clear();
  });

  const sendRequest = (message, timeoutMs = 15000) => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(message.requestId);
        reject(new Error('AI Runtime request timed out.'));
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

  const chat = (message, options = {}) => {
    return new Promise((resolve, reject) => {
      let started = false;
      const startTimeoutMs = options.startTimeoutMs || CHAT_START_TIMEOUT_MS;
      const doneTimeoutMs = Number.isFinite(options.doneTimeoutMs) && options.doneTimeoutMs > 0 ? options.doneTimeoutMs : 0;

      const startTimeoutId = setTimeout(() => {
        const stream = streaming.get(message.requestId);
        if (!stream || started) {
          return;
        }

        streaming.delete(message.requestId);
        postToPort({ type: 'runtime.abort', requestId: message.requestId }, 'runtime.abort');
        addDiagnostic('aiRuntime.chat.startTimeout', {
          requestId: message.requestId,
          timeoutMs: startTimeoutMs,
        });
        reject(new Error('AI Runtime did not start the chat request.'));
      }, startTimeoutMs);

      const doneTimeoutId = doneTimeoutMs
        ? setTimeout(() => {
            const stream = streaming.get(message.requestId);
            if (!stream) {
              return;
            }

            streaming.delete(message.requestId);
            postToPort({ type: 'runtime.abort', requestId: message.requestId }, 'runtime.abort');
            addDiagnostic('aiRuntime.chat.doneTimeout', {
              requestId: message.requestId,
              timeoutMs: doneTimeoutMs,
            });
            reject(new Error('AI Runtime chat request timed out.'));
          }, doneTimeoutMs)
        : null;

      streaming.set(message.requestId, {
        resolve: (value) => {
          clearTimeout(startTimeoutId);
          clearTimeout(doneTimeoutId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(startTimeoutId);
          clearTimeout(doneTimeoutId);
          reject(error);
        },
        text: '',
        provider: undefined,
        model: undefined,
        heartbeatCount: 0,
        markStarted: () => {
          started = true;
          clearTimeout(startTimeoutId);
        },
      });

      if (!postToPort(message, message.type)) {
        streaming.delete(message.requestId);
        clearTimeout(startTimeoutId);
        clearTimeout(doneTimeoutId);
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
    page: assignmentData.page,
    courseName: assignmentData.courseName,
    studentName: assignmentData.studentName,
    assignmentTitle: assignmentData.assignmentTitle,
    assignmentDescription: {
      source: assignmentData.linkedAssignmentDescription?.text ? 'linked-description' : 'inline-page',
      url: assignmentData.assignmentDescriptionLink?.url || '',
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
        name: file.name,
        url: file.url || '',
        mimeType: file.mimeType || '',
        sizeBytes: file.sizeBytes || null,
      })),
      extraFiles: (assignmentData.extraFiles || []).map((file) => ({
        id: file.id,
        name: file.name,
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

const fetchSubmissionFileAttachments = async (submissionFiles = []) => {
  const attachments = [];
  let totalBytes = 0;

  addDiagnostic('attachments.fetch.start', { count: submissionFiles.length });

  for (const file of submissionFiles) {
    if (totalBytes >= MAX_TOTAL_ATTACHMENT_BYTES) {
      addDiagnostic('attachments.fetch.totalLimit', { totalBytes });
      break;
    }

    try {
      const response = await fetch(file.url, {
        credentials: 'include',
      });

      if (!response.ok) {
        addDiagnostic('attachments.fetch.httpError', {
          id: file.id,
          status: response.status,
        });
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
        addDiagnostic('attachments.fetch.skippedLarge', {
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
        attachment.base64Data = arrayBufferToBase64(await blob.arrayBuffer());
      }

      attachments.push(attachment);
      addDiagnostic('attachments.fetch.ok', {
        id: file.id,
        name: file.name,
        mimeType,
        sizeBytes: blob.size,
      });
    } catch (error) {
      addDiagnostic('attachments.fetch.error', {
        id: file.id,
        message: error.message || String(error),
      });
      attachments.push({
        id: file.id,
        name: file.name,
        mimeType: 'text/plain',
        sizeBytes: 0,
        textContent: `Could not fetch submitted file ${file.name}: ${error.message || String(error)}`,
      });
    }
  }

  addDiagnostic('attachments.fetch.done', { count: attachments.length });
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
      attachments.push({
        id: file.id || `extra-file-${index + 1}`,
        name: file.name || `extra-file-${index + 1}`,
        mimeType: 'text/plain',
        sizeBytes,
        textContent: `Extra file ${file.name || index + 1} was detected but skipped because it is too large.`,
      });
      continue;
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
      attachment.textContent = `Extra file ${attachment.name} was selected but its content was not available.`;
    }

    attachments.push(attachment);
  }

  addDiagnostic('attachments.extra.normalized', { count: attachments.length });
  return attachments;
};

const createChatRequest = (assignmentData, requestId, files, route) => {
  return {
    type: 'runtime.chat',
    requestId,
    ...(route?.provider ? { provider: route.provider } : {}),
    ...(route?.model ? { model: route.model } : {}),
    messages: [
      {
        role: 'system',
        content:
          'You are an educational assessment assistant. You produce structured grading suggestions for a teacher to review.',
      },
      {
        role: 'user',
        content: buildCorrectionPrompt(assignmentData),
      },
    ],
    options: {
      responseFormat: 'json',
      temperature: 0.2,
    },
    ...(files.length > 0 ? { files } : {}),
  };
};

const createRepairChatRequest = (assignmentData, invalidResponseText, requestId, route) => ({
  type: 'runtime.chat',
  requestId,
  ...(route?.provider ? { provider: route.provider } : {}),
  ...(route?.model ? { model: route.model } : {}),
  messages: [
    {
      role: 'system',
      content:
        'You repair invalid AI grading output into the exact JSON schema required by Moodle Correction Assistant.',
    },
    {
      role: 'user',
      content: buildCorrectionRepairPrompt(assignmentData, invalidResponseText),
    },
  ],
  options: {
    responseFormat: 'json',
    temperature: 0.1,
  },
});

const isRetryableAiRouteError = (error) => {
  const message = error?.message || String(error || '');
  return /did not start|timed out|disconnected|LOCAL_PROVIDER_OFFLINE|Ollama error:\s*5\d\d|LM Studio error:\s*5\d\d|WebLLM error:\s*5\d\d/i.test(
    message,
  );
};

const runChatCorrection = async (runtime, assignmentData, files, mode, route) => {
  const chatRequestId = createRequestId();
  addDiagnostic('correction.chat.post', {
    requestId: chatRequestId,
    attachments: files.length,
    mode,
    route,
  });

  const isLocalRoute = route?.provider === 'ollama' || route?.provider === 'webllm' || route?.provider === 'lmstudio';
  const response = await runtime.chat(createChatRequest(assignmentData, chatRequestId, files, route), {
    startTimeoutMs: isLocalRoute ? LOCAL_CHAT_START_TIMEOUT_MS : CHAT_START_TIMEOUT_MS,
  });

  if (response?.type === 'runtime.chat.error' || response?.error) {
    addDiagnostic('correction.chat.error', {
      requestId: chatRequestId,
      error: response?.error?.message || null,
      mode,
    });
    throw new Error(response?.error?.message || 'AI correction request failed.');
  }

  if (response?.type !== 'runtime.chat.result') {
    addDiagnostic('correction.chat.unexpected', {
      requestId: chatRequestId,
      type: response?.type || null,
      mode,
    });
    throw new Error('AI Runtime returned an unexpected response.');
  }

  addDiagnostic('correction.chat.result', {
    requestId: chatRequestId,
    provider: response.provider,
    model: response.model,
    textLength: response.text?.length || 0,
    mode,
  });

  return response;
};

const runChatAcrossRoutes = async (extensionId, assignmentData, files, mode, routes) => {
  let lastError = null;

  for (const [index, route] of routes.entries()) {
    let runtime = null;

    try {
      addDiagnostic('correction.route.try', {
        mode,
        index,
        route,
      });

      runtime = await connectAiRuntime(extensionId);
      await runtime.sendRequest({
        type: 'runtime.handshake',
        requestId: createRequestId(),
        app: APP_INFO,
      });

      return await runChatCorrection(runtime, assignmentData, files, mode, route);
    } catch (error) {
      lastError = error;
      addDiagnostic('correction.route.failed', {
        mode,
        index,
        route,
        message: error.message || String(error),
        retryable: isRetryableAiRouteError(error),
      });

      if (!isRetryableAiRouteError(error)) {
        throw error;
      }
    } finally {
      runtime?.disconnect();
    }
  }

  throw lastError || new Error('No AI route could complete the correction.');
};

const selectExplicitRoute = async (runtime, appConfig = {}) => {
  const capabilities = await runtime.sendRequest({
    type: 'runtime.capabilities',
    requestId: createRequestId(),
  });

  const providers = capabilities.providers || [];
  const availableProviders = providers.filter((provider) => provider.available && provider.supports?.chat);
  const selectedProvider = availableProviders.find((provider) => provider.provider === 'ollama') || null;

  if (!selectedProvider) {
    addDiagnostic('correction.route.none', {
      providers: providers.map((provider) => ({
        provider: provider.provider,
        available: provider.available,
        reason: provider.reason || null,
      })),
    });
    throw new Error('AI Runtime has no available Ollama chat provider.');
  }

  const selectedModel = appConfig.provider === 'ollama' && appConfig.model ? appConfig.model : undefined;

  const route = {
    provider: selectedProvider.provider,
    ...(selectedModel ? { model: selectedModel } : {}),
  };
  const routeCandidates = [route];

  addDiagnostic('correction.route.selected', {
    route,
    routeCandidates,
    availableProviders: availableProviders.map((provider) => ({
      provider: provider.provider,
      models: provider.models?.length || 0,
    })),
  });

  return {
    selected: route,
    candidates: routeCandidates,
  };
};

const selectExplicitRouteFromCapabilities = (capabilities, appConfig = {}) => {
  const providers = capabilities.providers || [];
  const availableProviders = providers.filter((provider) => provider.available && provider.supports?.chat);
  const selectedProvider = availableProviders.find((provider) => provider.provider === 'ollama') || null;

  if (!selectedProvider) {
    addDiagnostic('correction.route.none', {
      providers: providers.map((provider) => ({
        provider: provider.provider,
        available: provider.available,
        reason: provider.reason || null,
      })),
    });
    throw new Error('AI Runtime has no available Ollama chat provider.');
  }

  const selectedModel = appConfig.provider === 'ollama' && appConfig.model ? appConfig.model : undefined;

  const route = {
    provider: selectedProvider.provider,
    ...(selectedModel ? { model: selectedModel } : {}),
  };
  const routeCandidates = [route];

  addDiagnostic('correction.route.selected', {
    route,
    routeCandidates,
    availableProviders: availableProviders.map((provider) => ({
      provider: provider.provider,
      models: provider.models?.length || 0,
    })),
  });

  return {
    selected: route,
    candidates: routeCandidates,
  };
};

const requestAiCorrection = async (assignmentData) => {
  addDiagnostic('correction.request.received', {
    hasAssignment: Boolean(assignmentData),
    files: assignmentData?.submissionFiles?.length || 0,
    extraFiles: assignmentData?.extraFiles?.length || 0,
    hasExtraInstructions: Boolean(assignmentData?.extraInstructions),
    rubricCriteria: assignmentData?.rubric?.length || 0,
    rubricLevelControls: assignmentData?.gradingControls?.rubricCriteriaWithLevelControls || 0,
    rubricCommentBoxes: assignmentData?.gradingControls?.rubricCriteriaWithCommentBoxes || 0,
    finalFeedback: Boolean(assignmentData?.gradingControls?.finalFeedback),
  });

  const aiExtensionId = await getAiExtensionId();

  if (!aiExtensionId) {
    addDiagnostic('correction.request.noAiExtension');
    throw new Error('AI Runtime is not installed or is disabled.');
  }

  const pageStatus = await sendAiRuntimeCall(
    aiExtensionId,
    {
      type: 'runtime.pageStatus',
      requestId: createRequestId(),
    },
    30_000,
  );
  addDiagnostic('correction.pageStatus.ok', {
    authorized: Boolean(pageStatus.status?.authorized),
    appConfig: pageStatus.status?.appConfig || {},
  });

  const capabilities = await sendAiRuntimeCall(
    aiExtensionId,
    {
      type: 'runtime.capabilities',
      requestId: createRequestId(),
    },
    30_000,
  );
  const storedAppConfig = await loadAiRuntimeConfig();
  const routeSelection = selectExplicitRouteFromCapabilities(capabilities, {
    ...(pageStatus.status?.appConfig || {}),
    ...storedAppConfig,
  });
  const files = [
    ...(await fetchSubmissionFileAttachments(assignmentData.submissionFiles || [])),
    ...normalizeExtraFileAttachments(assignmentData.extraFiles || []),
  ];
  const chatRequestId = createRequestId();

  addDiagnostic('correction.chat.post', {
    requestId: chatRequestId,
    attachments: files.length,
    mode: 'runtime-call',
    route: routeSelection.selected,
  });

  const response = await sendAiRuntimeCall(
    aiExtensionId,
    createChatRequest(assignmentData, chatRequestId, files, routeSelection.selected),
  );

  addDiagnostic('correction.chat.result', {
    requestId: chatRequestId,
    provider: response.provider,
    model: response.model,
    textLength: response.text?.length || 0,
    mode: 'runtime-call',
  });

  let parsed = parseCorrectionResponse(response.text, assignmentData);
  const completeness = getCorrectionCompleteness(parsed, assignmentData);

  if (!isCorrectionComplete(parsed, assignmentData)) {
    const repairRequestId = createRequestId();
    addDiagnostic('correction.repair.start', {
      requestId: repairRequestId,
      originalRequestId: chatRequestId,
      ...completeness,
    });

    try {
      const repairResponse = await sendAiRuntimeCall(
        aiExtensionId,
        createRepairChatRequest(assignmentData, response.text, repairRequestId, routeSelection.selected),
      );
      const repairedParsed = parseCorrectionResponse(repairResponse.text, assignmentData);
      const repairedCompleteness = getCorrectionCompleteness(repairedParsed, assignmentData);

      addDiagnostic('correction.repair.result', {
        requestId: repairRequestId,
        textLength: repairResponse.text?.length || 0,
        ...repairedCompleteness,
      });

      if (isCorrectionComplete(repairedParsed, assignmentData)) {
        parsed = repairedParsed;
      }
    } catch (error) {
      addDiagnostic('correction.repair.failed', {
        requestId: repairRequestId,
        message: error.message || String(error),
      });
    }
  }

  return {
    provider: response.provider,
    model: response.model,
    text: response.text,
    parsed,
    usage: response.usage,
  };
};

const withAiRuntime = async (callback) => {
  const aiExtensionInfo = await getAiExtensionInfo();
  const aiExtensionId = aiExtensionInfo?.id || '';

  if (!aiExtensionId) {
    throw new Error('AI Runtime is not installed or is disabled.');
  }

  const runtime = await connectAiRuntime(aiExtensionId);

  try {
    const handshake = await runtime.sendRequest({
      type: 'runtime.handshake',
      requestId: createRequestId(),
      app: APP_INFO,
    });

    if (!handshake?.ok) {
      throw new Error(handshake?.error?.message || 'AI Runtime rejected the handshake.');
    }

    return await callback(runtime, handshake, aiExtensionInfo);
  } finally {
    runtime.disconnect();
  }
};

const getAiRuntimeStatus = async () => {
  const aiExtensionInfo = await getAiExtensionInfo();
  const aiExtensionId = aiExtensionInfo?.id || '';

  if (!aiExtensionId) {
    throw new Error('AI Runtime is not installed or is disabled.');
  }

  const pageStatus = await sendAiRuntimeCall(
    aiExtensionId,
    {
      type: 'runtime.pageStatus',
      requestId: createRequestId(),
    },
    30_000,
  );
  const capabilities = await sendAiRuntimeCall(
    aiExtensionId,
    {
      type: 'runtime.capabilities',
      requestId: createRequestId(),
    },
    30_000,
  );

  const storedAppConfig = await loadAiRuntimeConfig();

  return {
    runtime: {
      extensionId: aiExtensionId,
      version: pageStatus.status?.version,
    },
    policy: {
      origin: pageStatus.status?.origin,
      enabled: pageStatus.status?.authorized,
    },
    appConfig: {
      ...(pageStatus.status?.appConfig || {}),
      ...storedAppConfig,
    },
    providers: capabilities.providers || [],
    extension: {
      id: aiExtensionInfo.id,
      name: aiExtensionInfo.name,
      optionsUrl: aiExtensionInfo.optionsUrl,
    },
  };
};

const setAiRuntimeConfig = async (config) => {
  const aiExtensionInfo = await getAiExtensionInfo();
  const aiExtensionId = aiExtensionInfo?.id || '';

  if (!aiExtensionId) {
    throw new Error('AI Runtime is not installed or is disabled.');
  }

  const response = await sendAiRuntimeCall(
    aiExtensionId,
    {
      type: 'runtime.appConfig.update',
      requestId: createRequestId(),
      config: {
        ...(config?.provider ? { provider: config.provider } : {}),
        ...(config?.model ? { model: config.model } : {}),
      },
    },
    30_000,
  );

  return await saveAiRuntimeConfig({
    ...sanitizeAiRuntimeConfig(config),
    ...sanitizeAiRuntimeConfig(response.config || {}),
  });
};

const openAiRuntimeOptions = async () => {
  const aiExtensionInfo = await getAiExtensionInfo();

  if (!aiExtensionInfo) {
    throw new Error('AI Runtime is not installed or is disabled.');
  }

  if (aiExtensionInfo.optionsUrl) {
    await openTab(aiExtensionInfo.optionsUrl);
    return true;
  }

  return await withAiRuntime(async (runtime) => {
    await runtime.sendRequest({
      type: 'runtime.openOptions',
      requestId: createRequestId(),
    });
    return true;
  });
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

const isCorrectionComplete = (correction, assignmentData = {}) => {
  const completeness = getCorrectionCompleteness(correction, assignmentData);
  return completeness.hasSupportedSchema && completeness.hasStudentFeedback && completeness.hasCompleteRubric;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mca.detectAiProxyBridge') {
    void getAiExtensionId()
      .then((extensionId) => sendResponse({ ok: true, extensionId }))
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
    void requestAiCorrection(message.assignmentData)
      .then((correction) => sendResponse({ ok: true, correction }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
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
