void (async () => {
await MoodliaCorrectorI18n.init();
MoodliaCorrectorI18n.localize(document);
const status = document.querySelector('#status');
const siteUrl = document.querySelector('#site-url');
const addView = document.querySelector('#add-view');
const manageView = document.querySelector('#manage-view');
const setStatus = message => { status.textContent = MoodliaCorrectorI18n.t(message); };
const runAction = action => { void action().catch(error => setStatus(error.message || String(error))); };

const renderSites = async () => {
  const sites = await MoodliaCorrectorActivation.getSites();
  const list = document.querySelector('#sites-list');
  list.replaceChildren(...sites.map(site => {
    const row = document.createElement('li');
    row.dataset.siteKey = site.key;
    const label = document.createElement('span');
    label.textContent = site.label;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = MoodliaCorrectorI18n.t('Quitar');
    remove.setAttribute('aria-label', MoodliaCorrectorI18n.message`Quitar ${site.label}`);
    remove.addEventListener('click', () => runAction(async () => {
      remove.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'mca.setAutomaticActivation', url: `${site.key}/mod/assign/view.php?action=grader`, enabled: false });
        if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido quitar el sitio.'));
        setStatus(MoodliaCorrectorI18n.t('Sitio quitado. En ese Moodle podrás abrir el corrector desde su icono.'));
        await renderSites();
        document.querySelector('#manage-title').focus();
      } finally { remove.disabled = false; }
    }));
    row.append(label, remove);
    return row;
  }));
  document.querySelector('#empty-sites').hidden = sites.length > 0;
};

document.querySelector('#add-site').addEventListener('click', () => {
  addView.hidden = false;
  manageView.hidden = true;
  siteUrl.focus();
});
document.querySelector('#manage-sites').addEventListener('click', () => runAction(async () => {
  addView.hidden = true;
  manageView.hidden = false;
  await renderSites();
  document.querySelector('#manage-title').focus();
}));
document.querySelector('#add-site-form').addEventListener('submit', event => {
  event.preventDefault();
  runAction(async () => {
    const button = document.querySelector('#save-site');
    button.disabled = true;
    try {
      const site = MoodliaCorrectorActivation.normalizeSiteInput(siteUrl.value);
      const granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] });
      if (!granted) throw new Error(MoodliaCorrectorI18n.t('No se ha concedido acceso a este Moodle.'));
      const response = await chrome.runtime.sendMessage({ type: 'mca.setAutomaticActivation', url: `${site.key}/mod/assign/view.php?action=grader`, enabled: true });
      if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido añadir el sitio.'));
      setStatus(MoodliaCorrectorI18n.t('Sitio añadido. El corrector se activará automáticamente en sus páginas de corrección.'));
      addView.hidden = true;
      manageView.hidden = false;
      await renderSites();
      document.querySelector('#manage-title').focus();
    } finally { button.disabled = false; }
  });
});

runAction(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let site;
  try { site = MoodliaCorrectorActivation.getSite(tab?.url); }
  catch { setStatus(MoodliaCorrectorI18n.t('Añade un Moodle o gestiona los sitios guardados. La corrección se abre desde su página de Moodle.')); return; }
  siteUrl.value = site.key;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: MoodliaCorrectorActivation.contentScripts });
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'mca.openPanel' });
  if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('No se ha podido abrir el panel de corrección.'));
  setStatus(MoodliaCorrectorI18n.t('Corrector abierto en el panel lateral de Moodle.'));
});

})();
