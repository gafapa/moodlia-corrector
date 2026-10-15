const form = document.querySelector('#ai-settings');
const provider = document.querySelector('#provider');
const baseUrl = document.querySelector('#baseUrl');
const model = document.querySelector('#model');
const apiKey = document.querySelector('#apiKey');
const apiKeyField = document.querySelector('#api-key-field');
const status = document.querySelector('#status');
const testButton = document.querySelector('#test-connection');
const cancelTestButton = document.querySelector('#cancel-test');
let savedConfig = {};
let testRequestId = null;

const defaultEndpoints = {
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': 'https://api.openai.com/v1',
};

const setStatus = (message) => {
  status.textContent = message;
};

const updateProviderFields = (event) => {
  const isOllama = provider.value === 'ollama';
  apiKeyField.hidden = isOllama;
  apiKey.required = !isOllama && !(savedConfig.hasApiKey && provider.value === savedConfig.provider && baseUrl.value.trim().replace(/\/+$/, '') === savedConfig.baseUrl);

  if (event?.type !== 'input' && (!baseUrl.value.trim() || Object.values(defaultEndpoints).includes(baseUrl.value.trim()))) {
    baseUrl.value = defaultEndpoints[provider.value];
  }
};

const loadSettings = async () => {
  const response = await chrome.runtime.sendMessage({ type: 'mca.getAiRuntimeStatus' });
  if (!response?.ok) {
    throw new Error(response?.error || 'Could not load AI settings.');
  }

  const config = response.status.appConfig || {};
  savedConfig = config;
  provider.value = config.provider || 'ollama';
  baseUrl.value = config.baseUrl || defaultEndpoints[provider.value];
  model.value = config.model || '';
  updateProviderFields();
  setStatus(config.reason || (config.reachable ? 'Server connected. Use Test connection to verify generation.' : 'Configure the connection.'));
};

const saveSettings = async () => {
  const config = {
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
  };
  const response = await chrome.runtime.sendMessage({ type: 'mca.setAiRuntimeConfig', config });
  if (!response?.ok) {
    throw new Error(response?.error || 'Could not save AI settings.');
  }
  apiKey.value = '';
  savedConfig = { ...response.config, hasApiKey: Boolean(config.apiKey) || savedConfig.hasApiKey && savedConfig.baseUrl === response.config.baseUrl && savedConfig.provider === response.config.provider };
  updateProviderFields();
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings().then(() => setStatus('Connection saved. Use Test connection to verify generation.')).catch((error) => setStatus(error.message || String(error)));
});

testButton.addEventListener('click', () => {
  if (!form.reportValidity()) return;
  testButton.disabled = true;
  setStatus('Testing generation with fictional data. A local model may take up to 5 minutes to load.');
  void (async () => {
    await saveSettings();
    testRequestId = crypto.randomUUID();
    cancelTestButton.hidden = false;
    const response = await chrome.runtime.sendMessage({ type: 'mca.testAiConnection', requestId: testRequestId });
    if (!response?.ok) throw new Error(response?.error || 'Connection test failed.');
    setStatus(`Generation verified: ${response.result.provider} / ${response.result.model} (${(response.result.elapsedMs / 1000).toFixed(1)} seconds).`);
  })().catch((error) => setStatus(error.message || String(error))).finally(() => {
    testButton.disabled = false;
    cancelTestButton.hidden = true;
    testRequestId = null;
  });
});

cancelTestButton.addEventListener('click', () => {
  if (testRequestId) void chrome.runtime.sendMessage({ type: 'mca.cancelCorrection', requestId: testRequestId }).catch((error) => setStatus(error.message));
});

provider.addEventListener('change', updateProviderFields);
baseUrl.addEventListener('input', updateProviderFields);
void loadSettings().catch((error) => setStatus(error.message || String(error)));
