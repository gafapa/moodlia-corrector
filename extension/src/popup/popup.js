const statusElement = document.querySelector('#status');
const assignmentPreview = document.querySelector('#assignmentPreview');
const correctionPreview = document.querySelector('#correctionPreview');
const extraInstructions = document.querySelector('#extraInstructions');
const extraFiles = document.querySelector('#extraFiles');
const extraFilesSummary = document.querySelector('#extraFilesSummary');
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

let currentAssignmentData = null;
let currentCorrection = null;

const setStatus = (message) => {
  statusElement.textContent = message;
};

const sendToBackground = (message) => chrome.runtime.sendMessage(message);

const getActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No se ha encontrado una pestaña activa.');
  }
  return tab;
};

const sendToActiveTab = async (message) => {
  const tab = await getActiveTab();
  return await chrome.tabs.sendMessage(tab.id, message);
};

const updateExtraFilesSummary = () => {
  const files = [...(extraFiles.files || [])];

  if (files.length === 0) {
    extraFilesSummary.textContent = 'Sin archivos adicionales.';
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  extraFilesSummary.textContent = `${files.length} archivo(s) adicional(es), ${(totalBytes / 1024 / 1024).toFixed(2)} MB.`;
};

const isTextAttachment = (file) =>
  file.type.startsWith('text/') || /\.(txt|csv|md|json|xml|html|css|js|ts|py|java|c|cpp|log)$/i.test(file.name);

const readFileAsBase64 = async (file) => {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

const readExtraFiles = async () => {
  const selectedFiles = [...(extraFiles.files || [])];
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
      attachment.base64Data = await readFileAsBase64(file);
    }

    attachments.push(attachment);
  }

  if (attachments.length > 0) {
    extraFilesSummary.textContent = `${attachments.length} archivo(s) preparado(s) para la IA.`;
  }

  return attachments;
};

const buildAssignmentDataForCorrection = async () => ({
  ...currentAssignmentData,
  extraInstructions: extraInstructions.value.trim(),
  extraFiles: await readExtraFiles(),
});

const detectAiProxyBridge = async () => {
  const response = await sendToBackground({ type: 'mca.detectAiProxyBridge' });
  if (!response?.ok) {
    throw new Error(response?.error || 'No se ha podido detectar la IA.');
  }

  if (!response.extensionId) {
    setStatus('La IA no está instalada o está desactivada.');
    return;
  }

  setStatus('IA detectada.');
};

const extractAssignment = async () => {
  setStatus('Extrayendo datos de Moodle...');
  const response = await sendToActiveTab({ type: 'mca.extractAssignment' });

  if (!response?.ok) {
    throw new Error(response?.error || 'No se han podido extraer los datos de Moodle.');
  }

  currentAssignmentData = response.assignmentData;
  assignmentPreview.value = JSON.stringify(currentAssignmentData, null, 2);
  setStatus('Datos de Moodle extraídos.');
};

const applyCorrection = async () => {
  if (!currentCorrection) {
    throw new Error('No hay corrección de IA disponible.');
  }

  const editedValue = correctionPreview.value.trim();
  let correctionToApply = currentCorrection;

  if (editedValue) {
    try {
      correctionToApply = {
        ...currentCorrection,
        parsed: JSON.parse(editedValue),
      };
    } catch {
      correctionToApply = {
        ...currentCorrection,
        parsed: {
          studentFeedback: editedValue,
        },
      };
    }
  }

  setStatus('Aplicando corrección en Moodle...');
  const response = await sendToActiveTab({
    type: 'mca.applyCorrection',
    correction: correctionToApply,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'No se ha podido aplicar la corrección.');
  }

  setStatus(
    `Aplicado: comentario=${response.result.commentApplied}, nota=${response.result.gradeApplied}, niveles=${response.result.rubricLevelsApplied}, comentarios=${response.result.rubricCommentsApplied}.`,
  );
};

const requestCorrection = async () => {
  if (!currentAssignmentData) {
    await extractAssignment();
  }

  const assignmentData = await buildAssignmentDataForCorrection();
  setStatus('Solicitando corrección a la IA...');
  const response = await sendToActiveTab({
    type: 'mca.requestCorrection',
    assignmentData,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'La corrección con IA ha fallado.');
  }

  currentCorrection = response.correction;
  correctionPreview.value = JSON.stringify(currentCorrection.parsed || currentCorrection.text, null, 2);
  await applyCorrection();
  setStatus(`Corrección aplicada (${currentCorrection.provider}/${currentCorrection.model}).`);
};

const runAction = (action) => {
  void action().catch((error) => {
    setStatus(error.message || String(error));
  });
};

document.querySelector('#requestCorrection').addEventListener('click', () => runAction(requestCorrection));
extraFiles.addEventListener('change', updateExtraFilesSummary);

runAction(detectAiProxyBridge);
