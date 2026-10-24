const form = document.querySelector('#ai-settings');
const provider = document.querySelector('#provider');
const baseUrl = document.querySelector('#baseUrl');
const endpointProtocol = document.querySelector('#endpointProtocol');
const endpointHost = document.querySelector('#endpointHost');
const endpointPort = document.querySelector('#endpointPort');
const endpointPath = document.querySelector('#endpointPath');
const endpointFields = [endpointProtocol, endpointHost, endpointPort, endpointPath];
const syncEndpointFields = () => {
  try {
    const parts = MoodliaCorrectorAiEndpoint.splitEndpoint(baseUrl.value);
    endpointProtocol.value = parts.protocol;
    endpointHost.value = parts.host;
    endpointPort.value = parts.port;
    endpointPath.value = parts.path;
    endpointHost.setCustomValidity('');
  } catch { /* Keep an unfinished full URL editable. */ }
  document.querySelector('#connection-security').hidden = !baseUrl.value.startsWith('http:');
};
const composeEndpointFields = () => {
  try {
    baseUrl.value = MoodliaCorrectorAiEndpoint.composeEndpoint({ protocol: endpointProtocol.value, host: endpointHost.value, port: endpointPort.value, path: endpointPath.value });
    endpointHost.setCustomValidity('');
  } catch (error) { endpointHost.setCustomValidity(MoodliaCorrectorI18n.t(error.message)); }
  document.querySelector('#connection-security').hidden = endpointProtocol.value !== 'http:';
};
const ensureServerAccess = async (config) => {
  const parts = MoodliaCorrectorAiEndpoint.splitEndpoint(config.baseUrl);
  if (parts.protocol !== 'http:') return;
  if (!MoodliaCorrectorAiProviders[config.provider].allowHttp) throw new Error(MoodliaCorrectorI18n.t('Remote API providers require HTTPS.'));
  if (['localhost', '127.0.0.1', '[::1]'].includes(parts.host)) return;
  const granted = await chrome.permissions.request({ origins: [`http://${parts.host}/*`] });
  if (!granted) throw new Error(MoodliaCorrectorI18n.t('Server access was not granted. The connection was not saved.'));
};
const model = document.querySelector('#model');
const apiKey = document.querySelector('#apiKey');
const apiKeyField = document.querySelector('#api-key-field');
const removeKeyButton = document.querySelector('#remove-api-key');
const normalizeEndpoint = (value) => {
  try { const url = new URL(value.trim()); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; } catch { return ''; }
};
const status = document.querySelector('#status');
const testButton = document.querySelector('#test-connection');
const cancelTestButton = document.querySelector('#cancel-test');
let savedConfig = {};
let providerProfiles = {};
let displayedProvider = provider.value;
let settingsRevision = 0;
form.addEventListener('input', event => { if (event.target.id !== 'modelSearch') settingsRevision++; });
form.addEventListener('change', event => { if (event.target.id !== 'modelSearch') settingsRevision++; });
let testRequestId = null;

const defaultEndpoints = Object.fromEntries(Object.entries(MoodliaCorrectorAiProviders).map(([id, definition]) => [id, definition.baseUrl]));
const modelSearch = document.querySelector('#modelSearch');
const modelPicker = document.querySelector('#available-models');
let availableModels = [];
const filterModels = () => {
  const query = modelSearch.value.trim().toLocaleLowerCase();
  const visible = availableModels.filter(item => `${item.name} ${item.id} ${item.description || ''}`.toLocaleLowerCase().includes(query));
  modelPicker.replaceChildren(...visible.map(item => new Option(item.label || item.name || item.id, item.id)));
  modelPicker.disabled = visible.length === 0;
  modelPicker.size = Math.min(5, Math.max(2, visible.length));
  modelPicker.value = model.value;
  modelSearch.disabled = availableModels.length === 0;
  document.querySelector('#model-count').textContent = localizeMessage(!availableModels.length
    ? 'No models listed. Refresh models or enter a model ID manually.'
    : !visible.length ? MoodliaCorrectorI18n.message`No matches among ${availableModels.length} models. Try another search.`
    : MoodliaCorrectorI18n.message`${visible.length} of ${availableModels.length} models${model.value ? MoodliaCorrectorI18n.message` · Selected: ${model.value}` : ''}`);
};
const renderModels = (models = []) => {
  availableModels = models;
  modelSearch.value = '';
  filterModels();
};
modelSearch.addEventListener('input', filterModels);
modelPicker.addEventListener('change', () => {
  model.value = modelPicker.value;
  model.dispatchEvent(new Event('input', { bubbles: true }));
  filterModels();
});
model.addEventListener('input', () => { modelPicker.value = model.value; });

const localizeMessage = message => MoodliaCorrectorI18n.t(message);
const setStatus = (message) => {
  status.textContent = localizeMessage(message);
};

const updateProviderFields = (event) => {
  if (event?.type === 'change') {
    providerProfiles[displayedProvider] = { baseUrl: baseUrl.value, model: model.value };
    const profile = providerProfiles[provider.value];
    baseUrl.value = profile?.baseUrl || defaultEndpoints[provider.value];
    model.value = profile?.model || '';
    displayedProvider = provider.value;
    apiKey.value = '';
    renderModels();
    syncEndpointFields();
  }
  const definition = MoodliaCorrectorAiProviders[provider.value];
  apiKeyField.hidden = provider.value === 'ollama';
  removeKeyButton.hidden = !savedConfig.hasApiKey;
  apiKey.required = definition.requiresApiKey && !(savedConfig.hasApiKey && provider.value === savedConfig.provider && normalizeEndpoint(baseUrl.value) === savedConfig.baseUrl);

};

const loadSettings = async () => {
  const revision = settingsRevision;
  const [response, storedProfiles] = await Promise.all([MoodliaCorrectorRuntime.send({ type: 'mca.getAiRuntimeStatus' }), chrome.storage.local.get('mca.aiProviderConfigs')]);
  if (!response?.ok) {
    throw new Error(response?.error || MoodliaCorrectorI18n.t('Could not load AI settings.'));
  }

  if (revision !== settingsRevision) return;
  const config = response.status.appConfig || {};
  savedConfig = config;
  providerProfiles = storedProfiles['mca.aiProviderConfigs'] || {};
  displayedProvider = config.provider || 'ollama';
  provider.value = config.provider || 'ollama';
  baseUrl.value = config.baseUrl || defaultEndpoints[provider.value];
  syncEndpointFields();
  model.value = config.model || '';
  renderModels(response.status.providers?.find((item) => item.provider === config.provider)?.models || []);
  updateProviderFields();
  setStatus(config.reason || (config.reachable ? 'Server connected. Use Test connection to verify generation.' : MoodliaCorrectorI18n.t('Configure the connection.')));
};

const saveSettings = async () => {
  const config = {
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
  };
  if (endpointFields.some(field => !field.reportValidity())) throw new Error(MoodliaCorrectorI18n.t('Review the server address and port.'));
  await ensureServerAccess(config);
  const response = await MoodliaCorrectorRuntime.send({ type: 'mca.setAiRuntimeConfig', config });
  if (!response?.ok) {
    throw new Error(response?.error || MoodliaCorrectorI18n.t('Could not save AI settings.'));
  }
  apiKey.value = '';
  savedConfig = { ...response.config, hasApiKey: Boolean(config.apiKey) || savedConfig.hasApiKey && savedConfig.baseUrl === response.config.baseUrl && savedConfig.provider === response.config.provider };
  updateProviderFields();
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings().then(() => setStatus(MoodliaCorrectorI18n.t('Connection saved. Use Test connection to verify generation.'))).catch((error) => setStatus(error.message || String(error)));
});

testButton.addEventListener('click', () => {
  if (!form.reportValidity()) return;
  testButton.disabled = true;
  setStatus(MoodliaCorrectorI18n.t('Testing generation with fictional data. A local model may take up to 5 minutes to load.'));
  void (async () => {
    await saveSettings();
    testRequestId = crypto.randomUUID();
    cancelTestButton.hidden = false;
    const response = await MoodliaCorrectorRuntime.send({ type: 'mca.testAiConnection', requestId: testRequestId });
    if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('Connection test failed.'));
    setStatus(MoodliaCorrectorI18n.message`Generation verified: ${response.result.provider} / ${response.result.model} (${(response.result.elapsedMs / 1000).toFixed(1)} seconds).`);
  })().catch((error) => setStatus(error.message || String(error))).finally(() => {
    testButton.disabled = false;
    cancelTestButton.hidden = true;
    testRequestId = null;
  });
});

cancelTestButton.addEventListener('click', () => {
  if (testRequestId) void MoodliaCorrectorRuntime.send({ type: 'mca.cancelCorrection', requestId: testRequestId }).catch((error) => setStatus(error.message));
});

provider.addEventListener('change', updateProviderFields);
baseUrl.addEventListener('input', () => { syncEndpointFields(); updateProviderFields(); });
for (const field of endpointFields) field.addEventListener('input', () => { composeEndpointFields(); updateProviderFields(); });
void loadSettings().catch((error) => setStatus(error.message || String(error)));

removeKeyButton.addEventListener('click', () => {
  removeKeyButton.disabled = true;
  void MoodliaCorrectorRuntime.send({ type: 'mca.setAiRuntimeConfig', config: { apiKey: '' } }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('Could not remove the API key.'));
    apiKey.value = '';
    savedConfig = { ...response.config, hasApiKey: false };
    updateProviderFields();
    setStatus(MoodliaCorrectorI18n.t('Saved API key removed.'));
  }).catch((error) => setStatus(error.message || String(error))).finally(() => { removeKeyButton.disabled = false; });
});

const loadModelsButton = document.querySelector('#load-models');
loadModelsButton.addEventListener('click', () => {
  if (!baseUrl.reportValidity() || !apiKey.reportValidity()) return;
  loadModelsButton.disabled = true;
  setStatus(MoodliaCorrectorI18n.t('Loading available models...'));
  const revision = settingsRevision;
  void (async () => {
    await saveSettings();
    const response = await MoodliaCorrectorRuntime.send({ type: 'mca.getAiRuntimeStatus' });
    if (revision !== settingsRevision) return;
    if (!response?.ok) throw new Error(response?.error || MoodliaCorrectorI18n.t('Could not list models.'));
    const connection = response.status.appConfig;
    if (!connection.reachable) throw new Error(connection.reason || MoodliaCorrectorI18n.t('The server is unavailable. Start its local API server and try again.'));
    const models = response.status.providers?.find((item) => item.provider === provider.value)?.models || [];
    renderModels(models);
    if (!model.value && models.length) model.value = models[0].id;
    filterModels();
    setStatus(models.length ? MoodliaCorrectorI18n.message`${models.length} model(s) found. Choose a model and test the connection.` : MoodliaCorrectorI18n.t('The server returned no models. Load a model in the server and try again.'));
  })().catch((error) => setStatus(error.message || String(error))).finally(() => { loadModelsButton.disabled = false; });
});
