(() => {
  const definitions = Object.freeze({
    ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', allowHttp: true, requiresApiKey: false },
    'lm-studio': { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', allowHttp: true, requiresApiKey: false },
    'llama-cpp': { label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', allowHttp: true, requiresApiKey: false },
    localai: { label: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1', allowHttp: true, requiresApiKey: false },
    vllm: { label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', allowHttp: true, requiresApiKey: false },
    'local-compatible': { label: 'Other local server (OpenAI-compatible)', baseUrl: 'http://127.0.0.1:8080/v1', allowHttp: true, requiresApiKey: false },
    'openai-compatible': { label: 'OpenAI-compatible API', baseUrl: 'https://api.openai.com/v1', allowHttp: false, requiresApiKey: true },
  });
  const composeEndpoint = ({ protocol, host, port, path = '' }) => {
    if (!['http:', 'https:'].includes(protocol)) throw new Error('Choose HTTP or HTTPS.');
    const hostname = String(host || '').trim();
    if (!hostname || /[\s/@?#%]/.test(hostname)) throw new Error('Enter a valid IP address or hostname without a URL path.');
    const authority = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    const url = new URL(`${protocol}//${authority}`);
    if (url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter the port in its separate field.');
    if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be between 1 and 65535.');
    if (/[?#]/.test(path)) throw new Error('The API path cannot contain a query string or fragment.');
    url.port = String(Number(port));
    url.pathname = path.startsWith('/') ? path : `/${path}`;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  };
  const splitEndpoint = (value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) URL without credentials, a query string, or a fragment.');
    return { protocol: url.protocol, host: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80'), path: url.pathname.replace(/\/+$/, '') };
  };
  globalThis.MoodliaCorrectorAiProviders = definitions;
  globalThis.MoodliaCorrectorAiEndpoint = { composeEndpoint, splitEndpoint };
})();
