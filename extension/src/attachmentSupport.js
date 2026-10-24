(() => {
  const textExtensions = /\.(txt|csv|md|markdown|json|jsonc|xml|html?|xhtml|css|scss|sass|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|pyw|ipynb|java|kt|kts|scala|c|h|cc|hh|cpp|hpp|cxx|hxx|cs|go|rs|swift|dart|php|phtml|rb|r|lua|pl|pm|sh|bash|zsh|fish|ps1|psm1|psd1|bat|cmd|sql|graphql|gql|yaml|yml|toml|ini|cfg|conf|tex|asm|s|vb|vbs|log)$/i;
  const documentExtensions = /\.(pdf|docx|odt|png|jpe?g|webp)$/i;
  const unsupportedExtensions = /\.(zip|rar|7z|doc|xls|xlsx|ods|ppt|pptx|odp|gif|svg|bmp|tiff?|heic|avif|mp[34]|wav|ogg|exe)$/i;
  const isText = (file = {}) => textExtensions.test(file.name || file.originalName || '') || String(file.mimeType || file.type || '').toLowerCase().startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript'].includes(String(file.mimeType || file.type || '').split(';')[0].trim().toLowerCase());
  const assess = (file = {}) => {
    const name = file.name || file.originalName || '';
    const mime = String(file.mimeType || file.type || '').split(';')[0].trim().toLowerCase();
    let path = name;
    if (!/\.[a-z0-9]+$/i.test(path) && file.url) {
      try { path = new URL(file.url).pathname; } catch { /* Keep the visible filename. */ }
    }
    if (unsupportedExtensions.test(path)) return { supported: false, reason: 'Formato no soportado' };
    if (textExtensions.test(path) || documentExtensions.test(path) || isText(file) ||
      ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { supported: true };
    if (typeof file.textContent === 'string' && !/\.[a-z0-9]+$/i.test(path)) return { supported: true };
    if (!/\.[a-z0-9]+$/i.test(path) && !mime) return { supported: null };
    return { supported: false, reason: 'Formato no soportado' };
  };
  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
  const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const MAX_TEXT = 600_000;
  const MAX_IMAGES = 120;
  const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
  const bytesToBase64 = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  const readSelectedFiles = async (selectedFiles) => {
    let totalBytes = 0;
    const attachments = [];
    for (const [index, file] of Array.from(selectedFiles).entries()) {
      const attachment = { id: `extra-file-${index + 1}`, name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, source: 'manual-upload' };
      if (assess(file).supported !== false) {
        totalBytes += file.size;
        if (file.size > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Los archivos adicionales superan el límite de 4 MB por archivo o 10 MB en total.');
        if (isText(file)) attachment.textContent = await file.text();
        else attachment.base64Data = bytesToBase64(await file.arrayBuffer());
      }
      attachments.push(attachment);
    }
    return attachments;
  };
  globalThis.MoodliaCorrectorAttachmentSupport = { assess, isText, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_TEXT, MAX_IMAGES, MAX_EXPANDED_BYTES, bytesToBase64, readSelectedFiles };
})();
