/**
 * compiler-worker.js -- Web Worker that loads gh-aw.wasm and exposes
 * the compileWorkflow and validateWorkflow functions via postMessage.
 *
 * Message protocol (inbound):
 *   { type: 'compile',  id: <number|string>, markdown: <string>, files?: <object> }
 *   { type: 'validate', id: <number|string>, markdown: <string>, files?: <object> }
 *
 * Message protocol (outbound):
 *   { type: 'ready' }
 *   { type: 'result',          id, yaml: <string>, warnings: <string[]>, error: null }
 *   { type: 'validate_result', id, errors: [{field, message, severity}], warnings: <string[]> }
 *   { type: 'error',           id, error: <string> }
 *
 * This file is a classic script (not an ES module) because Web Workers
 * need importScripts() to load wasm_exec.js synchronously.
 */

/* global importScripts, Go, compileWorkflow, validateWorkflow, WebAssembly */

'use strict';

(function () {
  // 1. Load Go's wasm_exec.js (provides the global `Go` class)
  importScripts('./wasm_exec.js');

  var ready = false;

  /**
   * Initialize the Go WebAssembly runtime.
   */
  async function init() {
    try {
      var go = new Go();

      // Try streaming instantiation first; fall back to array buffer
      // for servers that don't serve .wasm with application/wasm MIME type.
      var result;
      try {
        result = await WebAssembly.instantiateStreaming(
          fetch('./gh-aw.wasm'),
          go.importObject,
        );
      } catch (streamErr) {
        var resp = await fetch('./gh-aw.wasm');
        var buf = await resp.arrayBuffer();
        result = await WebAssembly.instantiate(buf, go.importObject);
      }

      // Start the Go program. go.run() never resolves because main()
      // does `select{}`, so we intentionally do NOT await it.
      go.run(result.instance);

      // Poll until the Go code has registered compileWorkflow on globalThis.
      await waitForGlobal('compileWorkflow', 5000);

      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: null,
        error: 'Worker initialization failed: ' + err.message,
      });
    }
  }

  /**
   * Poll for a global property to appear.
   */
  function waitForGlobal(name, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function check() {
        if (typeof self[name] !== 'undefined') {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Timed out waiting for globalThis.' + name));
        } else {
          setTimeout(check, 10);
        }
      })();
    });
  }

  /**
   * Handle incoming messages from the main thread.
   */
  self.onmessage = async function (event) {
    var msg = event.data;

    if (msg.type === 'compile') {
      await handleCompile(msg);
    } else if (msg.type === 'validate') {
      await handleValidate(msg);
    }
  };

  /**
   * Handle a compile request.
   */
  async function handleCompile(msg) {
    var id = msg.id;

    if (!ready) {
      self.postMessage({
        type: 'error',
        id: id,
        error: 'Compiler is not ready yet.',
      });
      return;
    }

    if (typeof msg.markdown !== 'string') {
      self.postMessage({
        type: 'error',
        id: id,
        error: 'markdown must be a string.',
      });
      return;
    }

    try {
      // compileWorkflow returns a Promise (Go side).
      // Pass optional files object for import resolution.
      var files = msg.files || null;
      var result = await compileWorkflow(msg.markdown, files);

      // The Go function returns { yaml: string, warnings: Array, error: null|object }
      var warnings = [];
      if (result.warnings) {
        for (var i = 0; i < result.warnings.length; i++) {
          warnings.push(result.warnings[i]);
        }
      }

      // error is now a structured object (or null) from Go, not a string
      var errorObj = null;
      if (result.error && typeof result.error === 'object') {
        errorObj = {
          message: result.error.message || '',
          field: result.error.field || null,
          line: result.error.line || null,
          column: result.error.column || null,
          severity: result.error.severity || 'error',
          suggestion: result.error.suggestion || null,
          docsUrl: result.error.docsUrl || null,
        };
      }

      self.postMessage({
        type: 'result',
        id: id,
        yaml: result.yaml || '',
        warnings: warnings,
        error: errorObj,
      });
    } catch (err) {
      // Promise rejection = unexpected error, wrap in structured format
      self.postMessage({
        type: 'error',
        id: id,
        error: err.message || String(err),
      });
    }
  }

  /**
   * Handle a validate request.
   */
  async function handleValidate(msg) {
    var id = msg.id;

    if (!ready) {
      self.postMessage({
        type: 'error',
        id: id,
        error: 'Compiler is not ready yet.',
      });
      return;
    }

    if (typeof msg.markdown !== 'string') {
      self.postMessage({
        type: 'error',
        id: id,
        error: 'markdown must be a string.',
      });
      return;
    }

    try {
      var files = msg.files || null;
      var result = await validateWorkflow(msg.markdown, files);

      // The Go function returns { errors: [{field, message, severity}], warnings: [] }
      var errors = [];
      if (result.errors) {
        for (var i = 0; i < result.errors.length; i++) {
          var e = result.errors[i];
          errors.push({
            field: e.field || '',
            message: e.message || '',
            severity: e.severity || 'error',
          });
        }
      }

      var warnings = [];
      if (result.warnings) {
        for (var j = 0; j < result.warnings.length; j++) {
          warnings.push(result.warnings[j]);
        }
      }

      self.postMessage({
        type: 'validate_result',
        id: id,
        errors: errors,
        warnings: warnings,
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: id,
        error: err.message || String(err),
      });
    }
  }

  // Start initialization immediately.
  init();
})();
