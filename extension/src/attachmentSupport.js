(() => {
  const textExtensions = /\.(txt|csv|md|markdown|json|jsonc|xml|html?|xhtml|css|scss|sass|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|pyw|ipynb|java|kt|kts|scala|c|h|cc|hh|cpp|hpp|cxx|hxx|cs|go|rs|swift|dart|php|phtml|rb|r|lua|pl|pm|sh|bash|zsh|fish|ps1|psm1|psd1|bat|cmd|sql|graphql|gql|yaml|yml|toml|ini|cfg|conf|tex|asm|s|vb|vbs|log)$/i;
  const documentExtensions = /\.(pdf|docx|odt|xlsx|ods|pptx|odp|png|jpe?g|webp)$/i;
  const unsupportedExtensions = /\.(zip|rar|7z|doc|xls|ppt|gif|svg|bmp|tiff?|heic|avif|mp[34]|wav|ogg|exe)$/i;
  const isText = (file = {}) => !documentExtensions.test(file.name || file.originalName || '') && (
    textExtensions.test(file.name || file.originalName || '') || String(file.mimeType || file.type || '').toLowerCase().startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript'].includes(String(file.mimeType || file.type || '').split(';')[0].trim().toLowerCase()));
  const assess = (file = {}) => {
    const name = file.name || file.originalName || '';
    const mime = String(file.mimeType || file.type || '').split(';')[0].trim().toLowerCase();
    let path = name;
    if (!/\.[a-z0-9]+$/i.test(path) && file.url) {
      try { path = new URL(file.url).pathname; } catch { /* Keep the visible filename. */ }
    }
    if (unsupportedExtensions.test(path)) return { supported: false, reason: 'Formato no soportado' };
    if (textExtensions.test(path) || documentExtensions.test(path) || isText(file) ||
      ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.presentation', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { supported: true };
    if (typeof file.textContent === 'string' && !/\.[a-z0-9]+$/i.test(path)) return { supported: true };
    if (!/\.[a-z0-9]+$/i.test(path) && !mime) return { supported: null };
    return { supported: false, reason: 'Formato no soportado' };
  };
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
  const MAX_TEXT = 600_000;
  const MAX_IMAGES = 120;
  const MAX_EXPANDED_BYTES = 48 * 1024 * 1024;
  const getSizeBytes = (file) => {
    const declared = Number(file.sizeBytes ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('Invalid attachment size.');
    let measured = 0;
    if (typeof file.base64Data === 'string') {
      const data = file.base64Data;
      measured = Math.max(0, Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));
    } else if (typeof file.textContent === 'string') {
      measured = new TextEncoder().encode(file.textContent).byteLength;
      // Decoded Windows-1252/UTF-16 text re-encodes to more UTF-8 bytes than the
      // original file. Trust the measured original size while it is plausible.
      const original = file.measuredBytes;
      if (Number.isSafeInteger(original) && original >= 0 && measured <= original * 3) measured = original;
    }
    return Math.max(declared, measured);
  };
  const bytesToBase64 = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  // Student source files are often saved as UTF-16 or Windows-1252, not UTF-8.
  const decodeText = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    // Without a BOM, UTF-16 text of Latin characters has NUL in every other byte.
    if (bytes.length >= 4) {
      const pairs = Math.floor(bytes.length / 2);
      let evenNul = 0;
      let oddNul = 0;
      for (let index = 0; index < pairs * 2; index += 2) {
        if (bytes[index] === 0) evenNul++;
        if (bytes[index + 1] === 0) oddNul++;
      }
      if (oddNul > pairs * 0.4 && evenNul < pairs * 0.05) return new TextDecoder('utf-16le').decode(bytes);
      if (evenNul > pairs * 0.4 && oddNul < pairs * 0.05) return new TextDecoder('utf-16be').decode(bytes);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('windows-1252').decode(bytes); }
  };
  const readSelectedFiles = async (selectedFiles) => {
    let totalBytes = 0;
    let textLength = 0;
    const attachments = [];
    for (const [index, file] of Array.from(selectedFiles).entries()) {
      // An empty type stays empty, so a file without extension is identified from its bytes later.
      const attachment = { id: `extra-file-${index + 1}`, name: file.name, mimeType: file.type || '', sizeBytes: file.size, source: 'manual-upload' };
      if (assess(file).supported !== false) {
        totalBytes += file.size;
        if (file.size > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Los archivos adicionales superan el límite de 20 MB por archivo o 40 MB en total.');
        if (isText(file)) {
          attachment.textContent = decodeText(await file.arrayBuffer());
          attachment.measuredBytes = file.size;
          // Decoded text can be several times its file size; stop before it is sent with the request.
          textLength += attachment.textContent.length;
          if (textLength > MAX_TEXT) throw new Error('Los archivos de texto adicionales superan el límite de 600.000 caracteres.');
        }
        else attachment.base64Data = bytesToBase64(await file.arrayBuffer());
      }
      attachments.push(attachment);
    }
    return attachments;
  };
  // The student's name as Moodle's grader shows it, as one pattern: the full name in
  // any case and in "Surname, Name" order, and each capitalised name part of three or
  // more letters as a whole word (also in capitals and without accents). Lower-case
  // words ("luna", "del") are never matched. Returns null without a usable name.
  const studentNamePattern = (name) => {
    const clean = String(name || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (clean.length < 3 || clean.length > 120) return null;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plain = value => value.normalize('NFD').replace(/\p{M}/gu, '');
    const parts = clean.split(' ').filter(part => [...part].length >= 3 && /^\p{Lu}/u.test(part));
    const phrases = new Set([clean]);
    if (parts.length >= 2) phrases.add(`${parts.slice(1).join(' ')}, ${parts[0]}`).add(`${parts.slice(1).join(' ')} ${parts[0]}`);
    const words = new Set(parts.flatMap(part => [part, part.toLocaleUpperCase(), plain(part), plain(part).toLocaleUpperCase()]));
    const alternatives = [...[...phrases].flatMap(phrase => [phrase, plain(phrase)]).map(phrase => `(?i:${escape(phrase)})`), ...[...words].map(escape)];
    // Longest first, so a full name is replaced once rather than word by word.
    alternatives.sort((a, b) => b.length - a.length);
    try { return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'gu'); }
    catch { return new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...words].map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu'); }
  };
  globalThis.MoodliaCorrectorAttachmentSupport = { assess, isText, getSizeBytes, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_TEXT, MAX_IMAGES, MAX_EXPANDED_BYTES, bytesToBase64, decodeText, readSelectedFiles, studentNamePattern };
})();
