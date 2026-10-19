void (async () => {
  await MoodliaCorrectorI18n.init();
  MoodliaCorrectorI18n.localize(document);
  const languagePicker = document.getElementById('interface-language');
  languagePicker.value = MoodliaCorrectorI18n.preference;
  languagePicker.addEventListener('change', async () => {
    await chrome.storage.local.set({ 'mca.uiLanguage': languagePicker.value });
    location.reload();
  });
  const parameters = new URLSearchParams(location.search);
  if (parameters.get('embedded') === '1') {
    const token = parameters.get('token');
    const response = await chrome.runtime.sendMessage({ type: 'mca.authorizeSettingsFrame', token });
    if (!response?.ok || window.parent === window) {
      document.body.textContent = MoodliaCorrectorI18n.t('Open advanced settings from the correction panel.');
      return;
    }
    document.documentElement.classList.add('embedded');
    window.addEventListener('message', event => {
      if (event.source === window.parent && event.data?.type === 'mca.cancelSettingsTest' && event.data.token === token) document.getElementById('cancel-test').click();
    });
    const reportSize = () => window.parent.postMessage({ type: 'mca.settingsFrameSize', token, height: Math.ceil(document.querySelector('main').getBoundingClientRect().height) + 8 }, '*');
    new ResizeObserver(reportSize).observe(document.querySelector('main'));
    reportSize();
  } else if (window.parent !== window) {
    document.body.textContent = MoodliaCorrectorI18n.t('Open settings from the extension.');
    return;
  }
  await import('./options.js');
})().catch(error => { document.body.textContent = error.message || String(error); });
