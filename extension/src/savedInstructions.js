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
    const states = Object.fromEntries(scopes.map(scope => [scope, { key: null, defaultKey: null, revision: 0, pending: new Map(), queued: null, timer: null }]));
    let writes = Promise.resolve();
    // Typing is saved once it pauses for SAVE_DELAY_MS rather than on every keystroke:
    // each write wakes the service worker and every extension page listening for
    // storage changes. A context change, a read of the values and leaving the page
    // save at once, so nothing typed is lost.
    const SAVE_DELAY_MS = 400;
    const flush = (scope) => {
      const state = states[scope];
      clearTimeout(state.timer);
      state.timer = null;
      const queued = state.queued;
      if (!queued) return writes;
      state.queued = null;
      const defaults = queued.defaultKey ? { [queued.defaultKey]: queued.value } : {};
      writes = writes.then(() => chrome.storage.local.set({ [queued.key]: queued.value, ...defaults }))
        .catch(() => onError(MoodliaCorrectorI18n.t('No se han podido guardar los criterios docentes.')))
        .finally(() => {
          const remaining = (state.pending.get(queued.key) || 1) - 1;
          if (remaining) state.pending.set(queued.key, remaining); else state.pending.delete(queued.key);
        });
      return writes;
    };
    const flushAll = () => { for (const scope of scopes) flush(scope); return writes; };
    globalThis.addEventListener?.('pagehide', flushAll);
    let legacyText = '';
    let ready = Promise.resolve();
    for (const scope of scopes) {
      const field = fields[scope];
      field.disabled = true;
      field.addEventListener('input', () => {
        const state = states[scope];
        if (!state.key) return;
        state.revision++;
        if (state.queued && state.queued.key !== state.key) flush(scope);
        // Counted once per queued write; storage echoes of a pending key are ignored.
        if (!state.queued) state.pending.set(state.key, (state.pending.get(state.key) || 0) + 1);
        state.queued = { key: state.key, defaultKey: state.defaultKey, value: field.value };
        clearTimeout(state.timer);
        state.timer = setTimeout(() => flush(scope), SAVE_DELAY_MS);
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
      flushAll();
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
        // Stay disabled until the saved value loads: typing earlier would be
        // written over the stored criteria when the load is discarded.
        fields[scope].disabled = true;
        fields[scope].title = key ? '' : MoodliaCorrectorI18n.t('Este contexto todavía no se ha detectado en Moodle.');
        if (!key) continue;
        const defaultKey = state.defaultKey;
        loads.push(writes.then(() => chrome.storage.local.get(defaultKey ? [key, defaultKey] : key)).then(values => {
          if (state.key !== key || state.revision !== revision) return;
          fields[scope].disabled = false;
          const ownValue = typeof values[key] === 'string';
          const fallback = defaultKey && typeof values[defaultKey] === 'string' ? values[defaultKey] : '';
          fields[scope].value = ownValue ? values[key] : fallback;
          if (defaultKey) {
            // Persist a copy in the new scope, preserving existing values, including deliberate blanks.
            fields[scope].dispatchEvent(new Event('input', { bubbles: true }));
            return flush(scope);
          }
        }).catch(() => {
          // Keep the field locked: an unknown stored value must not be overwritten.
          onError(MoodliaCorrectorI18n.t('No se han podido recuperar los criterios guardados.'));
        }));
      }
      if (legacyButton) legacyButton.disabled = !keys.assignment;
      ready = Promise.all([ready, ...loads]).then(() => undefined);
      return ready;
    };
    const getValues = async () => {
      flushAll();
      await ready;
      return Object.fromEntries(scopes.map(scope => [scope, states[scope].key ? fields[scope].value.trim() : '']));
    };
    return { setContext, getValues };
  };
  globalThis.MoodliaCorrectorPreferences = { createController, getScopeKeys };
})();
