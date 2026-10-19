(() => {
  const render = (container, assignment, additionalFiles = [], skippedFiles = []) => {
    const fragment = document.createDocumentFragment();
    container.classList.add('mca-file-preview');
    container.tabIndex = 0;
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', MoodliaCorrectorI18n.t('Archivos para la IA'));
    const style = document.createElement('style');
    style.textContent = `
      .mca-file-preview { max-height: 240px; overflow: auto; overflow-wrap: anywhere; overscroll-behavior: contain; }
      .mca-file-preview:focus-visible { outline: 2px solid #2453a6; outline-offset: 2px; }
      .mca-file-preview .file-group { margin: 0 0 10px; display: block; }
      .mca-file-preview .file-group h4 { margin: 0; font-size: 12px; }
      .mca-file-preview .file-purpose { margin: 1px 0 3px; font-size: 12px; color: #536070; }
      .mca-file-preview .file-names { margin: 0; padding-left: 16px; display: grid; gap: 2px; }
      .mca-file-preview .file-note { margin: 4px 0 0; color: #536070; font-size: 12px; }
      .mca-file-preview .file-skipped { color: #b42318; }
      .mca-file-preview .file-skip-reason { display: block; font-size: 12px; }
    `;
    fragment.appendChild(style);
    const groups = [
      { role: 'assignment-reference', title: MoodliaCorrectorI18n.t('Enunciado'), files: assignment?.assignmentFiles || [], purpose: MoodliaCorrectorI18n.t('Referencia o plantilla; no se evalúa como entrega.') },
      { role: 'student-submission', title: MoodliaCorrectorI18n.t('Entrega'), files: assignment?.submissionFiles || [], purpose: MoodliaCorrectorI18n.t('Trabajo del alumno a evaluar.') },
      { role: 'teacher-additional', title: MoodliaCorrectorI18n.t('Adicionales'), files: [...additionalFiles], purpose: MoodliaCorrectorI18n.t('Material docente, según tus instrucciones.') },
    ];
    let total = 0;
    let skipped = 0;
    for (const group of groups) {
      if (!group.files.length) continue;
      total += group.files.length;
      const section = document.createElement('div');
      section.className = 'file-group';
      const heading = document.createElement('h4');
      heading.textContent = `${group.title} (${group.files.length})`;
      const list = document.createElement('ul');
      list.className = 'file-names';
      const purpose = document.createElement('p');
      purpose.className = 'file-purpose';
      purpose.textContent = group.purpose;
      for (const [index, file] of group.files.entries()) {
        const item = document.createElement('li');
        item.dataset.fileRole = group.role;
        const name = document.createElement('strong');
        name.textContent = file.originalName || file.name || MoodliaCorrectorI18n.t('Archivo sin nombre');
        const id = file.id || (group.role === 'teacher-additional' ? `extra-file-${index + 1}` : '');
        const reported = skippedFiles.find(entry => entry.role === group.role && (id && entry.id === id && (!entry.name || entry.name === file.name) || !entry.id && file.name && entry.name === file.name));
        const assessment = MoodliaCorrectorAttachmentSupport.assess(file);
        const reason = MoodliaCorrectorI18n.t(reported?.reason || (assessment.supported === false ? assessment.reason : ''));
        item.title = group.purpose;
        item.setAttribute('aria-label', `${name.textContent}. ${group.purpose}`);
        item.appendChild(name);
        if (reason) {
          skipped++;
          item.classList.add('file-skipped');
          item.dataset.fileStatus = 'skipped';
          const explanation = document.createElement('span');
          explanation.className = 'file-skip-reason';
          explanation.textContent = MoodliaCorrectorI18n.message`Omitido · ${reason}`;
          item.setAttribute('aria-label', MoodliaCorrectorI18n.message`${name.textContent}. Omitido: ${reason}. ${group.purpose}`);
          item.appendChild(explanation);
        }
        list.appendChild(item);
      }
      section.append(heading, purpose, list);
      fragment.appendChild(section);
    }
    const note = document.createElement('p');
    note.className = 'file-note';
    note.title = MoodliaCorrectorI18n.t('Los formatos no soportados se omiten. Los errores al leer formatos compatibles se avisan por separado.');
    note.textContent = total
      ? MoodliaCorrectorI18n.message`${total - skipped} incluido(s)${skipped ? MoodliaCorrectorI18n.message` · ${skipped} omitido(s)` : ''} · Se leerán al corregir.`
      : assignment ? 'No hay archivos para incluir.' : MoodliaCorrectorI18n.t('Pendiente de detectar los archivos de Moodle.');
    fragment.appendChild(note);
    if (assignment?.submissionText) {
      const onlineText = document.createElement('p');
      onlineText.className = 'file-note';
      onlineText.textContent = MoodliaCorrectorI18n.t('Texto en línea · Entrega a evaluar.');
      fragment.appendChild(onlineText);
    }
    container.replaceChildren(fragment);
  };
  globalThis.MoodliaCorrectorFilePreview = { render };
})();
