(() => {
  const storageKey = 'mca.activationSites';
  const prefix = 'mca-site-';
  const contentScripts = ['src/i18nMessages.js', 'src/i18n.js', 'src/aiProviders.js', 'src/attachmentSupport.js', 'src/correctionSchema.js', 'src/savedInstructions.js', 'src/filePreview.js', 'src/content/moodleContent.js'];
  const getSite = (value) => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Abre una página de corrección de tareas de Moodle por HTTPS.'); }
    if (url.protocol !== 'https:' || !url.pathname.endsWith('/mod/assign/view.php') || url.searchParams.get('action') !== 'grader' || url.username || url.password) throw new Error('Abre una página de corrección de tareas de Moodle por HTTPS.');
    const basePath = url.pathname.slice(0, -'/mod/assign/view.php'.length);
    return { key: `${url.origin}${basePath}`, origin: url.origin, basePath, label: `${url.origin}${basePath}` };
  };
  const normalizeSiteInput = value => {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Introduce la dirección HTTPS de tu Moodle.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Usa HTTPS sin credenciales en la dirección.');
    if (url.pathname.endsWith('/mod/assign/view.php')) {
      url.search = '?action=grader';
      url.hash = '';
      return getSite(url.href);
    }
    if (url.search || url.hash || /\.php\/?$/i.test(url.pathname) || url.pathname.includes('*')) throw new Error('Introduce la dirección base del Moodle o una página de corrección.');
    return getSite(`${url.origin}${url.pathname.replace(/\/+$/, '')}/mod/assign/view.php?action=grader`);
  };
  const getSites = async () => {
    const stored = (await chrome.storage.local.get(storageKey))[storageKey];
    return Array.isArray(stored) ? stored.flatMap(entry => {
      try { const site = getSite(`${entry.key}/mod/assign/view.php?action=grader`); return site.key === entry.key ? [site] : []; } catch { return []; }
    }) : [];
  };
  let syncQueue = Promise.resolve();
  const sync = () => {
    const task = syncQueue.catch(() => {}).then(async () => {
      const sites = await getSites();
      const granted = [];
      for (const site of sites) if (await chrome.permissions.contains({ origins: [`${site.origin}/*`] })) granted.push(site);
      const current = (await chrome.scripting.getRegisteredContentScripts()).filter(entry => entry.id.startsWith(prefix));
      const desired = granted.map(site => ({ id: prefix + encodeURIComponent(site.key), matches: [`${site.key}/mod/assign/view.php*`], js: contentScripts, runAt: 'document_idle', persistAcrossSessions: true }));
      const desiredIds = new Set(desired.map(entry => entry.id));
      const remove = current.filter(entry => !desiredIds.has(entry.id)).map(entry => entry.id);
      if (remove.length) await chrome.scripting.unregisterContentScripts({ ids: remove });
      const existingIds = new Set(current.map(entry => entry.id));
      const added = desired.filter(entry => !existingIds.has(entry.id));
      const updated = desired.filter(entry => existingIds.has(entry.id));
      if (added.length) await chrome.scripting.registerContentScripts(added);
      if (updated.length) await chrome.scripting.updateContentScripts(updated);
      return granted;
    });
    syncQueue = task;
    return task;
  };
  let writeQueue = Promise.resolve();
  const setEnabled = (url, enabled) => {
    const task = writeQueue.catch(() => {}).then(async () => {
      const site = getSite(url);
      const sites = (await getSites()).filter(entry => entry.key !== site.key);
      if (enabled) sites.push(site);
      await chrome.storage.local.set({ [storageKey]: sites });
      await sync();
      return Boolean(enabled);
    });
    writeQueue = task;
    return task;
  };
  globalThis.MoodliaCorrectorActivation = { storageKey, contentScripts, getSite, normalizeSiteInput, getSites, sync, setEnabled };
})();
