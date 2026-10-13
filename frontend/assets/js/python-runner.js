var pyodide = null;
var activeRunId = null;

self.onmessage = async function(event) {
  var message = event.data || {};
  activeRunId = message.runId;

  try {
    if (message.type === 'init') {
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
      pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/'
      });
      self.postMessage({ type: 'ready', runId: activeRunId });
      return;
    }

    if (message.type === 'run' && pyodide) {
      var runId = activeRunId;
      pyodide.setStdout({
        batched: function(text) {
          self.postMessage({ type: 'output', runId: runId, text: text + '\n' });
        }
      });
      pyodide.setStderr({
        batched: function(text) {
          self.postMessage({ type: 'output', runId: runId, text: text + '\n' });
        }
      });
      await pyodide.runPythonAsync(message.code);
      self.postMessage({ type: 'complete', runId: runId });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      runId: activeRunId,
      message: error && error.message ? error.message : String(error)
    });
  }
};
