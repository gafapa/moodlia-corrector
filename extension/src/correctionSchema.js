(() => {
const getLanguageInstruction = (languageCode = '') => {
  const normalized = String(languageCode || '').toLowerCase();
  const languageMap = {
    fr: 'French (français)',
    de: 'German (Deutsch)',
    pt: 'Portuguese (português)',
    it: 'Italian (italiano)',
    ca: 'Catalan (català)',
    gl: 'Galician (galego)',
    'gl-es': 'Galician (galego)',
    es: 'Spanish (español)',
    'es-es': 'Spanish (español)',
    en: 'English',
    'en-us': 'English',
    'en-gb': 'English',
  };

  return languageMap[normalized] || languageMap[normalized.split('-')[0]] || languageCode || 'the Moodle page language';
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

const normalizeRubricLevelIndex = (criterion = {}, selection = {}) => {
  const validLevelIndexes = getValidRubricLevelIndexes(criterion);
  const raw = selection?.levelIndex ?? selection?.level_index ?? selection?.level;
  const hasExplicitLevel = ['levelIndex', 'level_index', 'level'].some((key) => Object.hasOwn(selection, key));
  if (hasExplicitLevel) {
    if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '') return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && validLevelIndexes.includes(parsed) ? parsed : null;
  }
  return null;
};

const getSelectionCriterionNumber = (selection = {}) => {
  const rawNumber =
    selection.criterionNumber ??
    selection.criterion_number ??
    selection.number ??
    selection.order ??
    null;
  if (!['number', 'string'].includes(typeof rawNumber) || String(rawNumber).trim() === '') {
    return null;
  }
  const criterionNumber = Number(rawNumber);
  return Number.isInteger(criterionNumber) ? criterionNumber : null;
};

const getSelectionCriterionIndex = (selection = {}) => {
  const rawIndex = selection.criterionIndex ?? selection.criterion_index ?? selection.index ?? null;
  if (!['number', 'string'].includes(typeof rawIndex) || String(rawIndex).trim() === '') {
    return null;
  }
  const criterionIndex = Number(rawIndex);
  return Number.isInteger(criterionIndex) ? criterionIndex : null;
};

const findRubricSelectionForCriterion = (rubricSelections = [], criterion = {}, criterionIndex = 0) => {
  const candidates = rubricSelections.filter((selection) => selection && typeof selection === 'object' && !Array.isArray(selection));
  const byId = candidates.filter((selection) => selection?.criterionId === criterion.id);
  if (byId.length > 1) return {};
  const selectionById = byId[0];
  if (selectionById) {
    return selectionById;
  }

  const byNumber = candidates.filter((selection) => {
    if (Object.hasOwn(selection, 'criterionId')) return false;
    const criterionNumber = getSelectionCriterionNumber(selection);
    const explicitCriterionIndex = getSelectionCriterionIndex(selection);
    if (criterionNumber !== null && explicitCriterionIndex !== null && explicitCriterionIndex !== criterionNumber - 1) return false;
    return criterionNumber === criterionIndex + 1 || explicitCriterionIndex === criterionIndex;
  });
  if (byNumber.length === 1) return byNumber[0];

  return {};
};

const normalizeRubricSelections = (assignmentData = {}, rubricSelections = [], baseFeedback = '') => {
  const expectedCriteria = getRubricCriteriaWithLevels(assignmentData);

  return expectedCriteria.map((criterion, criterionIndex) => {
    const matchingSelection = findRubricSelectionForCriterion(rubricSelections, criterion, criterionIndex);

    return {
      criterionId: criterion.id,
      levelIndex: matchingSelection.criterionId && matchingSelection.criterionId !== criterion.id ? null : normalizeRubricLevelIndex(criterion, matchingSelection),
      criterionFeedback:
        matchingSelection.criterionFeedback ||
        matchingSelection.finalFeedback ||
        matchingSelection.feedback ||
        matchingSelection.comment ||
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

const normalizeCorrectionResponse = (parsed, assignmentData = {}, options = {}) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const studentFeedback = getFinalComment(parsed);
  const rubricSelections = getRubricSelectionsInput(parsed);
  const rubricInputComplete = getRubricCriteriaWithLevels(assignmentData).every((criterion, index) => {
    const selection = findRubricSelectionForCriterion(rubricSelections, criterion, index);
    const level = selection.levelIndex ?? selection.level_index ?? selection.level;
    const feedback = selection.criterionFeedback || selection.finalFeedback || selection.feedback || selection.comment;
    return ['number', 'string'].includes(typeof level) && String(level).trim() !== '' && Number.isInteger(Number(level)) &&
      getValidRubricLevelIndexes(criterion).includes(Number(level)) &&
      (!options.requireCriterionIds || selection.criterionId === criterion.id) &&
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
    needsRepair: parsed.needsRepair === true || typeof studentFeedback !== 'string' || !rubricInputComplete || rubricSelections.length !== getRubricCriteriaWithLevels(assignmentData).length,
    studentFeedback,
    score: hasNumericGradeControl(assignmentData) && ['number', 'string'].includes(typeof parsed.score) && String(parsed.score).trim() !== '' && Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null,
    maxScore: getExpectedMaxScore(assignmentData),
    rubricSelections: normalizeRubricSelections(assignmentData, rubricSelections, studentFeedback),
  };
};

const parseCorrectionResponse = (text, assignmentData = {}) =>
  normalizeCorrectionResponse(parseJsonResponse(text), assignmentData, { requireCriterionIds: true }) || buildFallbackCorrection(text, assignmentData);

const getCorrectionCompleteness = (correction, assignmentData = {}) => {
  const expectedRubricCount = getRubricCriteriaWithLevels(assignmentData).length;
  const actualRubricCount = Array.isArray(correction?.rubricSelections) ? correction.rubricSelections.length : 0;

  return {
    hasStudentFeedback: Boolean(correction?.studentFeedback?.trim?.()),
    hasSupportedSchema: correction?.needsRepair !== true,
    hasValidScore: !hasNumericGradeControl(assignmentData) || Number.isFinite(correction?.score) && correction.score >= 0 && (getExpectedMaxScore(assignmentData) === null || correction.score <= getExpectedMaxScore(assignmentData)),
    expectedRubricCount,
    actualRubricCount,
    hasCompleteRubric: actualRubricCount === expectedRubricCount && getRubricCriteriaWithLevels(assignmentData).every((criterion) => {
      const matches = (correction?.rubricSelections || []).filter((selection) => selection.criterionId === criterion.id);
      return matches.length === 1 && Number.isInteger(matches[0].levelIndex) &&
        getValidRubricLevelIndexes(criterion).includes(matches[0].levelIndex) && Boolean(matches[0].criterionFeedback?.trim?.());
    }),
  };
};

const isCorrectionComplete = (correction, assignmentData = {}) => {
  const completeness = getCorrectionCompleteness(correction, assignmentData);
  return completeness.hasSupportedSchema && completeness.hasStudentFeedback && completeness.hasCompleteRubric && completeness.hasValidScore;
};


globalThis.MoodliaCorrectorSchema = { getLanguageInstruction, getRubricCriteriaWithLevels, getExpectedMaxScore, hasNumericGradeControl, getScoreTemplate, buildRubricSelectionTemplate, buildRubricLevelReference, parseJsonResponse, stripMarkdownForFeedback, buildFallbackCorrection, buildFallbackRubricFeedback, buildFallbackRubricSelections, getValidRubricLevelIndexes, normalizeRubricLevelIndex, getSelectionCriterionNumber, getSelectionCriterionIndex, findRubricSelectionForCriterion, normalizeRubricSelections, getFinalComment, getRubricSelectionsInput, getForeignSchemaFeedback, normalizeCorrectionResponse, parseCorrectionResponse, getCorrectionCompleteness, isCorrectionComplete };
})();
