(() => {
  const longRequests = new Set(['mca.correctAssignment', 'mca.testAiConnection']);
  // Long requests may report progress ({ type: 'mca.progress' }) before their response.
  const send = (message, { onProgress } = {}) => {
    if (!longRequests.has(message?.type)) return chrome.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      let port;
      let heartbeat;
      let deadline;
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(deadline);
        try { port?.disconnect(); } catch { /* The worker may already be disconnected. */ }
        if (error) reject(error); else resolve(response);
      };
      try {
        port = chrome.runtime.connect({ name: 'mca.longRequest' });
        port.onMessage.addListener((response) => {
          if (response?.type === 'mca.progress') { try { onProgress?.(response.progress); } catch { /* Progress display is optional. */ } return; }
          finish(null, response);
        });
        port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError;
          finish(new Error(error?.message || 'The extension connection closed before completion. Reload the extension and Moodle page, then request a new correction. No result was applied.'));
        });
        heartbeat = setInterval(() => {
          try { port.postMessage({ type: 'mca.heartbeat' }); }
          catch (error) { finish(error); }
        }, 20_000);
        // One minute beyond the service worker's 60-minute correction deadline, so its own error arrives first.
        deadline = setTimeout(() => finish(new Error('The operation exceeded 60 minutes and was cancelled. No result was applied.')), 61 * 60_000);
        port.postMessage(message);
      } catch (error) { finish(error); }
    });
  };
  globalThis.MoodliaCorrectorRuntime = { send };
})();
