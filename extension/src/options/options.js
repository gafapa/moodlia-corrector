const form = document.querySelector('#ai-settings');
const provider = document.querySelector('#provider');
const baseUrl = document.querySelector('#baseUrl');
const model = document.querySelector('#model');
const apiKey = document.querySelector('#apiKey');
const apiKeyField = document.querySelector('#api-key-field');
const status = document.querySelector('#status');

const defaultEndpoints = {
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': 'https://api.openai.com/v1',
};

const setStatus = (message) => {
  status.textContent = message;
};

const updateProviderFields = () => {
  const isOllama = provider.value === 'ollama';
  apiKeyField.hidden = isOllama;
  apiKey.required = !isOllama;

  if (!baseUrl.value.trim() || Object.values(defaultEndpoints).includes(baseUrl.value.trim())) {
    baseUrl.value = defaultEndpoints[provider.value];
  }
};

const loadSettings = async () => {
  const response = await chrome.runtime.sendMessage({ type: 'mca.getAiRuntimeStatus' });
  if (!response?.ok) {
    throw new Error(response?.error || 'Could not load AI settings.');
  }

  const config = response.status.appConfig || {};
  provider.value = config.provider || 'ollama';
  baseUrl.value = config.baseUrl || defaultEndpoints[provider.value];
  model.value = config.model || '';
  updateProviderFields();
  setStatus(config.configured ? 'Connection ready for this Chrome session.' : 'Choose a model and configure the connection.');
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
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
    setStatus('Connection saved. The API key, if provided, is available only until Chrome is closed.');
  })().catch((error) => setStatus(error.message || String(error)));
});

provider.addEventListener('change', updateProviderFields);
void loadSettings().catch((error) => setStatus(error.message || String(error)));
