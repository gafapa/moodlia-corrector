(() => {
  // Two collapsible groups: teacher material (reference and supporting files) and the student submission.
  // A group with a skipped file opens on its own; otherwise a group keeps the state the teacher left it in.
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  const STYLE = `
    .mca-file-preview { display: grid; gap: 6px; overflow-wrap: anywhere; }
    .mca-file-preview .file-group > summary { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; border-radius: 8px; background: #f7f9fb; list-style: none; cursor: pointer; }
    .mca-file-preview .file-group > summary::-webkit-details-marker { display: none; }
    .mca-file-preview .file-group > summary:hover, .mca-file-preview .file-group[open] > summary { background: #eef2f8; }
    .mca-file-preview .group-chevron { flex: none; display: inline-flex; color: #4a5568; transition: transform 140ms ease; }
    .mca-file-preview .group-chevron svg { width: 14px; height: 14px; }
    .mca-file-preview .file-group[open] .group-chevron { transform: rotate(90deg); }
    .mca-file-preview .group-title { flex: none; font-weight: 600; }
    .mca-file-preview .group-count { flex: 1 1 0; min-width: 0; color: #4a5568; font-size: 12px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mca-file-preview .group-count strong { color: #b42318; font-weight: 600; }
    .mca-file-preview .file-names { margin: 4px 0 0; padding: 0 0 0 22px; list-style: none; display: grid; gap: 2px; }
    .mca-file-preview .file-names li { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-height: 30px; padding: 0 8px; border-radius: 6px; font-size: 12.5px; }
    .mca-file-preview .file-type { flex: none; width: 34px; color: #163a78; font-size: 10px; font-weight: 700; letter-spacing: 0.03em; }
    .mca-file-preview .file-names strong { flex: 1 1 0; min-width: 0; overflow: hidden; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
    .mca-file-preview .file-meta { flex: none; color: #4a5568; font-size: 11px; }
    .mca-file-preview .file-names li.file-skipped { padding: 4px 8px; color: #b42318; background: #fdf0ee; }
    .mca-file-preview .file-skipped .file-type, .mca-file-preview .file-skipped .file-meta { color: inherit; }
    .mca-file-preview .file-skipped strong { text-decoration: line-through; }
    .mca-file-preview .file-skip-reason { flex-basis: 100%; padding-left: 42px; font-size: 12px; font-weight: 500; }
    .mca-file-preview .file-empty { color: #4a5568; }
    .mca-file-preview .file-add { padding: 2px 0 0 8px; }
    .mca-file-preview .file-note { margin: 0; color: #4a5568; font-size: 12px; }
  `;
  const extensionOf = (name = '') => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || '').toUpperCase();
  const formatSize = (bytes) => {
    if (!(bytes > 0)) return '';
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const render = (container, assignment, additionalFiles = [], skippedFiles = [], { addControl = null } = {}) => {
    const { t, message } = MoodliaCorrectorI18n;
    const previousOpen = Object.fromEntries([...container.querySelectorAll('[data-file-group]')].map(group => [group.dataset.fileGroup, group.open]));
    const fragment = document.createDocumentFragment();
    container.classList.add('mca-file-preview');
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', t('Archivos para la IA'));
    const style = document.createElement('style');
    style.textContent = STYLE;
    fragment.appendChild(style);
    const roles = {
      'assignment-reference': { label: t('Enunciado'), purpose: t('Referencia o plantilla; no se evalúa como entrega.') },
      'student-submission': { label: '', purpose: t('Trabajo del alumno a evaluar.') },
      'teacher-additional': { label: t('Apoyo'), purpose: t('Material docente, según tus instrucciones.') },
    };
    const groups = [
      { id: 'teacher', title: t('Material docente'), entries: [
        ...(assignment?.assignmentFiles || []).map((file, index) => ({ file, index, role: 'assignment-reference' })),
        ...additionalFiles.map((file, index) => ({ file, index, role: 'teacher-additional' })),
      ] },
      { id: 'submission', title: t('Entrega del alumno'), entries: (assignment?.submissionFiles || []).map((file, index) => ({ file, index, role: 'student-submission' })) },
    ];
    let total = 0;
    let skipped = 0;
    let openedForAttention = false;
    for (const group of groups) {
      let groupSkipped = 0;
      const details = document.createElement('details');
      details.className = 'file-group';
      details.dataset.fileGroup = group.id;
      details.name = 'mca-evidence-group';
      const summary = document.createElement('summary');
      const chevron = document.createElement('span');
      chevron.className = 'group-chevron';
      chevron.innerHTML = CHEVRON;
      const title = document.createElement('span');
      title.className = 'group-title';
      title.textContent = group.title;
      const count = document.createElement('span');
      count.className = 'group-count';
      summary.append(chevron, title, count);
      const list = document.createElement('ul');
      list.className = 'file-names';
      for (const { file, index, role } of group.entries) {
        const { label, purpose } = roles[role];
        const item = document.createElement('li');
        item.dataset.fileRole = role;
        const displayName = file.originalName || file.name || t('Archivo sin nombre');
        const type = document.createElement('span');
        type.className = 'file-type';
        type.setAttribute('aria-hidden', 'true');
        type.textContent = extensionOf(displayName);
        const name = document.createElement('strong');
        name.textContent = displayName;
        const meta = document.createElement('span');
        meta.className = 'file-meta';
        meta.textContent = label || formatSize(MoodliaCorrectorAttachmentSupport.getSizeBytes(file));
        const id = file.id || (role === 'teacher-additional' ? `extra-file-${index + 1}` : '');
        const reported = skippedFiles.find(entry => entry.role === role && (id && entry.id === id && (!entry.name || entry.name === file.name) || !entry.id && file.name && entry.name === file.name));
        const assessment = MoodliaCorrectorAttachmentSupport.assess(file);
        const reason = t(reported?.reason || (assessment.supported === false ? assessment.reason : ''));
        item.title = purpose;
        item.setAttribute('aria-label', `${displayName}. ${purpose}`);
        item.append(type, name, meta);
        if (reason) {
          groupSkipped++;
          item.classList.add('file-skipped');
          item.dataset.fileStatus = 'skipped';
          const explanation = document.createElement('span');
          explanation.className = 'file-skip-reason';
          explanation.textContent = message`Omitido · ${reason}`;
          item.setAttribute('aria-label', message`${displayName}. Omitido: ${reason}. ${purpose}`);
          item.appendChild(explanation);
        }
        list.appendChild(item);
      }
      if (!group.entries.length) {
        const empty = document.createElement('li');
        empty.className = 'file-empty';
        empty.textContent = assignment ? t('Sin archivos.') : t('Pendiente de detectar los archivos de Moodle.');
        list.appendChild(empty);
      }
      if (group.id === 'teacher' && addControl) {
        const addRow = document.createElement('li');
        addRow.className = 'file-add';
        addRow.appendChild(addControl);
        list.appendChild(addRow);
      }
      total += group.entries.length;
      skipped += groupSkipped;
      count.textContent = message`${group.entries.length - groupSkipped} incluido(s)`;
      if (groupSkipped) {
        const omitted = document.createElement('strong');
        omitted.textContent = message` · ${groupSkipped} omitido(s)`;
        count.appendChild(omitted);
      }
      // Only one group opens on its own, since the groups behave as an accordion.
      const needsAttention = groupSkipped > 0 && !openedForAttention;
      if (needsAttention) openedForAttention = true;
      details.open = needsAttention || Boolean(previousOpen[group.id] && !openedForAttention);
      details.append(summary, list);
      fragment.appendChild(details);
    }
    const notes = [];
    if (assignment && !total && !assignment.submissionText) notes.push(t('No hay archivos para incluir.'));
    if (assignment?.submissionText) notes.push(t('Texto en línea · Entrega a evaluar.'));
    for (const text of notes) {
      const note = document.createElement('p');
      note.className = 'file-note';
      note.textContent = text;
      fragment.appendChild(note);
    }
    container.replaceChildren(fragment);
    return { total, skipped, included: total - skipped, attention: skipped > 0 || Boolean(assignment && !total && !assignment.submissionText) };
  };
  globalThis.MoodliaCorrectorFilePreview = { render };
})();
