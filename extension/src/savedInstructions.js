(() => {
  const legacyKey = 'correctorExtraInstructions';
  const scopes = ['course', 'assignment', 'case'];
  const getDefaultKey = (context, scope) => context?.site && scope !== 'case'
    ? `mca.teacherCriteria:${encodeURIComponent(context.site)}:default:${scope}` : null;
  const getScopeKeys = (context = {}) => {
    const site = context.site;
    const assignment = context.assignmentId;
    const prefix = site ? `mca.teacherCriteria:${encodeURIComponent(site)}` : '';
    return {
      course: prefix && context.courseId ? `${prefix}:course:${encodeURIComponent(context.courseId)}` : null,
      assignment: prefix && assignment ? `${prefix}:assignment:${encodeURIComponent(assignment)}` : null,
      case: prefix && assignment && context.userId ? `${prefix}:assignment:${encodeURIComponent(assignment)}:user:${encodeURIComponent(context.userId)}:attempt:${encodeURIComponent(context.attemptId || '0')}` : null,
    };
  };

  const createController = (fields, onError, legacyButton) => {
    const states = Object.fromEntries(scopes.map(scope => [scope, { key: null, defaultKey: null, revision: 0, pending: new Map() }]));
    let writes = Promise.resolve();
    let legacyText = '';
    let ready = Promise.resolve();
    for (const scope of scopes) {
      const field = fields[scope];
      field.disabled = true;
      field.addEventListener('input', () => {
        const state = states[scope];
        if (!state.key) return;
        state.revision++;
        const key = state.key;
        const value = field.value;
        state.pending.set(key, (state.pending.get(key) || 0) + 1);
        const defaults = state.defaultKey ? { [state.defaultKey]: value } : {};
        writes = writes.then(() => chrome.storage.local.set({ [key]: value, ...defaults }))
          .catch(() => onError(MoodliaCorrectorI18n.t('No se han podido guardar los criterios docentes.')))
          .finally(() => {
            const remaining = (state.pending.get(key) || 1) - 1;
            if (remaining) state.pending.set(key, remaining); else state.pending.delete(key);
          });
      });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const scope of scopes) {
        const state = states[scope];
        if (!state.key || !changes[state.key] || state.pending.has(state.key)) continue;
        state.revision++;
        fields[scope].value = typeof changes[state.key].newValue === 'string' ? changes[state.key].newValue : '';
      }
    });
    if (legacyButton) {
      legacyButton.hidden = true;
      void chrome.storage.local.get(legacyKey).then(values => {
        legacyText = typeof values[legacyKey] === 'string' ? values[legacyKey] : '';
        legacyButton.hidden = !legacyText;
      }).catch(() => onError(MoodliaCorrectorI18n.t('No se han podido recuperar las instrucciones anteriores.')));
      legacyButton.addEventListener('click', () => {
        if (!states.assignment.key || !legacyText) return;
        const field = fields.assignment;
        if (field.value.includes(legacyText)) return;
        field.value = field.value ? `${field.value}\n\n${legacyText}` : legacyText;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    const setContext = (context) => {
      const keys = getScopeKeys(context);
      const loads = [];
      for (const scope of scopes) {
        const state = states[scope];
        const key = keys[scope];
        if (state.key === key) continue;
        state.key = key;
        state.defaultKey = getDefaultKey(context, scope);
        const revision = ++state.revision;
        fields[scope].value = '';
        fields[scope].disabled = !key;
        fields[scope].title = key ? '' : MoodliaCorrectorI18n.t('Este contexto todavía no se ha detectado en Moodle.');
        if (!key) continue;
        const defaultKey = state.defaultKey;
        loads.push(writes.then(() => chrome.storage.local.get(defaultKey ? [key, defaultKey] : key)).then(values => {
          if (state.key !== key || state.revision !== revision) return;
          const ownValue = typeof values[key] === 'string';
          const fallback = defaultKey && typeof values[defaultKey] === 'string' ? values[defaultKey] : '';
          fields[scope].value = ownValue ? values[key] : fallback;
          if (defaultKey) {
            // Persist a copy in the new scope, preserving existing values, including deliberate blanks.
            fields[scope].dispatchEvent(new Event('input', { bubbles: true }));
            return writes;
          }
        }).catch(() => onError(MoodliaCorrectorI18n.t('No se han podido recuperar los criterios guardados.'))));
      }
      if (legacyButton) legacyButton.disabled = !keys.assignment;
      ready = Promise.all([ready, ...loads]).then(() => undefined);
      return ready;
    };
    const getValues = async () => {
      await ready;
      return Object.fromEntries(scopes.map(scope => [scope, states[scope].key ? fields[scope].value.trim() : '']));
    };
    return { setContext, getValues };
  };
  globalThis.MoodliaCorrectorPreferences = { createController, getScopeKeys };
})();
