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

// Always a placeholder: a concrete example such as 7.5 is copied by weak models.
const getScoreTemplate = () => null;

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

// Moodle marking guide ("gradingform_guide"): one score input (0..maxScore) and
// one remark per criterion. Moodle sums the scores into the grade itself.
const toGuideMaxScore = (value) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const getGuideCriteria = (assignmentData = {}) =>
  (assignmentData.gradingGuide || []).filter(
    (criterion) => criterion?.id && criterion.controls?.score !== false && toGuideMaxScore(criterion.maxScore) !== null,
  );

const buildGuideScoreTemplate = (assignmentData = {}) =>
  getGuideCriteria(assignmentData).map((criterion, criterionIndex) => ({
    criterionId: criterion.id,
    score: null,
    remark: `Remark for guide criterion ${criterionIndex + 1}, in the Moodle page language.`,
  }));

const buildGuideReference = (assignmentData = {}) =>
  getGuideCriteria(assignmentData).map((criterion) => ({
    criterionId: criterion.id,
    shortName: criterion.shortName || '',
    description: criterion.description || '',
    ...(criterion.markerDescription ? { markerDescription: criterion.markerDescription } : {}),
    maxScore: toGuideMaxScore(criterion.maxScore),
  }));

// Scale grading: the visible labels of the Moodle select, without "No grade" (-1).
const getScaleOptions = (assignmentData = {}) => {
  if (!assignmentData.gradingControls?.gradeScale) return [];
  const seen = new Set();
  return (assignmentData.gradeScaleOptions || []).filter((option) => {
    const label = String(option?.label || '').trim();
    if (!label || String(option?.value) === '-1' || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
};

const normalizeScaleGrade = (assignmentData = {}, raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const options = getScaleOptions(assignmentData);
  const compact = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  return (options.find((option) => option.label.trim() === raw.trim()) ||
    options.find((option) => compact(option.label) === compact(raw)))?.label.trim() || null;
};

// Extra keys of the AI template, added only for a guide or a scale so other prompts stay unchanged.
const buildGradingTemplateExtras = (assignmentData = {}) => ({
  ...(getGuideCriteria(assignmentData).length ? { guideScores: buildGuideScoreTemplate(assignmentData) } : {}),
  ...(getScaleOptions(assignmentData).length ? { scaleGrade: null } : {}),
});

const buildGradingPromptRules = (assignmentData = {}) => {
  const guide = buildGuideReference(assignmentData);
  const scale = getScaleOptions(assignmentData).map((option) => option.label.trim());
  return [
    ...(guide.length ? [
      'Marking guide rules:',
      `- The Moodle marking guide has ${guide.length} criterion item(s). Return exactly ${guide.length} guideScores item(s), one per criterionId from the template, with exactly the keys criterionId, score, and remark.`,
      '- score is a number from 0 to that criterion maxScore in the Marking guide reference below, chosen from the evidence. The null in the template is only a placeholder; there is no default score.',
      '- remark explains briefly, in the feedback language, why that score was given and cites the most relevant evidence. markerDescription is guidance for the marker, not text for the student.',
      '- Moodle adds the criterion scores into the grade itself; keep score null at the top level.',
      '',
      'Marking guide reference:',
      JSON.stringify(guide, null, 2),
      '',
    ] : []),
    ...(scale.length ? [
      'Scale grade rules:',
      '- Moodle grades this assignment with a scale. scaleGrade must be exactly one of these labels, copied verbatim, chosen from the evidence:',
      JSON.stringify(scale),
      '- The null in the template is only a placeholder. Keep score null.',
      '',
    ] : []),
  ];
};

const buildGradingSchemaExtras = (assignmentData = {}) => {
  const guide = buildGuideReference(assignmentData);
  const scale = getScaleOptions(assignmentData).map((option) => option.label.trim());
  return {
    properties: {
      ...(guide.length ? { guideScores: { type: 'array', minItems: guide.length, maxItems: guide.length,
        items: { oneOf: guide.map((criterion) => ({
          type: 'object', additionalProperties: false,
          properties: {
            criterionId: { const: criterion.criterionId },
            score: { type: 'number', minimum: 0, maximum: criterion.maxScore },
            remark: { type: 'string', minLength: 1 },
          }, required: ['criterionId', 'score', 'remark'],
        })) } } } : {}),
      ...(scale.length ? { scaleGrade: { type: 'string', enum: scale } } : {}),
    },
    required: [...(guide.length ? ['guideScores'] : []), ...(scale.length ? ['scaleGrade'] : [])],
  };
};

const getGuideScoresInput = (parsed = {}) =>
  [parsed.guideScores, parsed.guideCriteria, parsed.markingGuide].find((candidate) => Array.isArray(candidate)) || [];

const getGuideRemark = (entry = {}) =>
  [entry.remark, entry.criterionFeedback, entry.feedback, entry.comment].find((value) => typeof value === 'string' && value.trim()) || '';

const normalizeGuideScoreValue = (criterion = {}, entry = {}) => {
  const raw = entry?.score ?? entry?.points;
  if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '') return null;
  const score = Number(String(raw).trim().replace(',', '.'));
  const maximum = toGuideMaxScore(criterion.maxScore);
  return Number.isFinite(score) && score >= 0 && maximum !== null && score <= maximum ? score : null;
};

const normalizeGuideScores = (assignmentData = {}, guideScores = []) =>
  getGuideCriteria(assignmentData).map((criterion, criterionIndex) => {
    const entry = findRubricSelectionForCriterion(guideScores, criterion, criterionIndex);
    const mismatched = entry.criterionId && entry.criterionId !== criterion.id;
    return { criterionId: criterion.id, score: mismatched ? null : normalizeGuideScoreValue(criterion, entry), remark: mismatched ? '' : getGuideRemark(entry) };
  });

const isGuideInputComplete = (assignmentData = {}, guideScores = [], options = {}) => {
  const criteria = getGuideCriteria(assignmentData);
  return guideScores.length === criteria.length && criteria.every((criterion, index) => {
    const entry = findRubricSelectionForCriterion(guideScores, criterion, index);
    return (!options.requireCriterionIds || entry.criterionId === criterion.id) && (!entry.criterionId || entry.criterionId === criterion.id) &&
      normalizeGuideScoreValue(criterion, entry) !== null && Boolean(getGuideRemark(entry));
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
    ...buildFallbackGradingExtras(assignmentData),
  };
};

const buildFallbackGradingExtras = (assignmentData = {}) => ({
  ...(getGuideCriteria(assignmentData).length ? { guideScores: normalizeGuideScores(assignmentData, []) } : {}),
  ...(getScaleOptions(assignmentData).length ? { scaleGrade: null } : {}),
});

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

// The schema key wins; legacy aliases only fill in when it is absent.
const getFinalComment = (parsed = {}) =>
  parsed.studentFeedback ||
  parsed.finalComment ||
  parsed.finalFeedback ||
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
    Object.prototype.hasOwnProperty.call(parsed, 'criteria') ||
    Object.prototype.hasOwnProperty.call(parsed, 'guideScores') ||
    Object.prototype.hasOwnProperty.call(parsed, 'scaleGrade');
  const guideScores = getGuideScoresInput(parsed);
  const hasGuide = getGuideCriteria(assignmentData).length > 0;
  const hasScale = getScaleOptions(assignmentData).length > 0;

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
      ...buildFallbackGradingExtras(assignmentData),
    };
  }

  // A returned maxScore on another scale ("8" with maxScore 100) must not be
  // applied as 8 on this assignment's scale. A missing maxScore is accepted.
  const expectedMax = getExpectedMaxScore(assignmentData);
  const mismatchedScale = expectedMax !== null && parsed.maxScore !== undefined && parsed.maxScore !== null &&
    Number(parsed.maxScore) !== expectedMax;
  return {
    needsRepair: parsed.needsRepair === true || mismatchedScale || typeof studentFeedback !== 'string' || !rubricInputComplete || rubricSelections.length !== getRubricCriteriaWithLevels(assignmentData).length ||
      hasGuide && !isGuideInputComplete(assignmentData, guideScores, options),
    studentFeedback,
    score: hasNumericGradeControl(assignmentData) && ['number', 'string'].includes(typeof parsed.score) && String(parsed.score).trim() !== '' && Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null,
    maxScore: getExpectedMaxScore(assignmentData),
    rubricSelections: normalizeRubricSelections(assignmentData, rubricSelections, studentFeedback),
    ...(hasGuide ? { guideScores: normalizeGuideScores(assignmentData, guideScores) } : {}),
    // A missing scale choice leaves the select untouched, like a missing score.
    ...(hasScale ? { scaleGrade: normalizeScaleGrade(assignmentData, parsed.scaleGrade) } : {}),
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
    expectedGuideCount: getGuideCriteria(assignmentData).length,
    hasCompleteGuide: getGuideCriteria(assignmentData).every((criterion) => {
      const matches = (correction?.guideScores || []).filter((entry) => entry?.criterionId === criterion.id);
      return matches.length === 1 && normalizeGuideScoreValue(criterion, matches[0]) !== null && Boolean(matches[0].remark?.trim?.());
    }),
    hasValidScaleGrade: getScaleOptions(assignmentData).length === 0 || normalizeScaleGrade(assignmentData, correction?.scaleGrade) !== null,
  };
};

const isCorrectionComplete = (correction, assignmentData = {}) => {
  const completeness = getCorrectionCompleteness(correction, assignmentData);
  return completeness.hasSupportedSchema && completeness.hasStudentFeedback && completeness.hasCompleteRubric && completeness.hasValidScore &&
    completeness.hasCompleteGuide && completeness.hasValidScaleGrade;
};


globalThis.MoodliaCorrectorSchema = { getLanguageInstruction, getRubricCriteriaWithLevels, getExpectedMaxScore, hasNumericGradeControl, getScoreTemplate, buildRubricSelectionTemplate, buildRubricLevelReference, parseJsonResponse, stripMarkdownForFeedback, buildFallbackCorrection, buildFallbackRubricFeedback, buildFallbackRubricSelections, getValidRubricLevelIndexes, normalizeRubricLevelIndex, getSelectionCriterionNumber, getSelectionCriterionIndex, findRubricSelectionForCriterion, normalizeRubricSelections, getFinalComment, getRubricSelectionsInput, getForeignSchemaFeedback, normalizeCorrectionResponse, parseCorrectionResponse, getCorrectionCompleteness, isCorrectionComplete, getGuideCriteria, buildGuideScoreTemplate, buildGuideReference, getScaleOptions, normalizeScaleGrade, buildGradingTemplateExtras, buildGradingPromptRules, buildGradingSchemaExtras, normalizeGuideScores };
})();
