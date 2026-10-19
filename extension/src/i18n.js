(() => {
  if (globalThis.MoodliaCorrectorI18n) return;
  const data = globalThis.MoodliaCorrectorMessages;
  const normalizeLocale = value => {
    const language = String(value || '').replace('_', '-').toLowerCase();
    if (language.split('-')[0] === 'pt') return 'pt_BR';
    return data.locales.includes(language.split('-')[0]) ? language.split('-')[0] : 'en';
  };
  let locale = normalizeLocale(globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language);
  let preference = '';
  let initialization;
  const init = () => initialization ||= (async () => {
    try {
      const saved = await chrome.storage.local.get('mca.uiLanguage');
      preference = data.locales.includes(saved['mca.uiLanguage']) ? saved['mca.uiLanguage'] : '';
      if (preference) locale = preference;
    } catch { /* Browser language remains usable when extension storage is unavailable. */ }
    return locale;
  })();
  const t = (source, values = []) => {
    const key = data.aliases[source];
    const text = data.catalogs[locale]?.[key]?.message || data.catalogs.en[key]?.message || source;
    return String(text).replace(/\$(\d+)/g, (match, number) => Number(number) <= values.length ? String(values[Number(number) - 1]) : match);
  };
  const message = (parts, ...values) => t(parts.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), ''), values);
  // Call only on freshly created extension UI, before any Moodle or teacher content is inserted.
  const localize = root => {
    const document = root.ownerDocument || root;
    const walker = document.createTreeWalker(root, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('script, style, textarea, pre, code, [data-no-i18n]')) continue;
      const source = node.textContent.trim();
      if (data.aliases[source]) node.textContent = node.textContent.replace(source, t(source));
    }
    const elements = [...(root.querySelectorAll?.('*') || [])];
    if (root.nodeType === 1) elements.unshift(root);
    for (const element of elements) for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const source = element.getAttribute(attribute);
      if (source && data.aliases[source]) element.setAttribute(attribute, t(source));
    }
    const languageRoot = root.nodeType === 9 ? root.documentElement : root;
    languageRoot.lang = locale.replace('_', '-');
  };
  globalThis.MoodliaCorrectorI18n = { init, t, message, localize, normalizeLocale, get locale() { return locale; }, get preference() { return preference; }, locales: data.locales };
})();
