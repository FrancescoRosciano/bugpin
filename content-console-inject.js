/**
 * BugPin — MAIN world console/error capture.
 *
 * Classic script, document_start. MUST NOT use `import` or `chrome.*` — the
 * MAIN world cannot see the extension APIs. Talks to the ISOLATED-world
 * bridge (content-bridge.js) purely via window.postMessage.
 *
 * Mirrors MSG.MAIN_TO_BRIDGE from lib/messages.js as a literal string since
 * this file cannot import that module. See PROTOCOL.md §2.
 */
(function bugpinMainInject() {
  'use strict';

  if (window.__bugpinMainInjected__) return;
  window.__bugpinMainInjected__ = true;

  // Capture references before the host page can override them.
  // These are snapshotted at document_start, before any page script runs. The
  // patched console methods live for the whole page lifetime, so anything they
  // reach for later must be captured here too — a page that swaps
  // Array.prototype.slice or WeakSet after load would otherwise make capture
  // throw and go silently dark (the page's own console still works).
  var NATIVE = {
    postMessage: window.postMessage.bind(window),
    jsonStringify: JSON.stringify,
    isArray: Array.isArray,
    dateNow: Date.now,
    addEventListener: window.addEventListener.bind(window),
    slice: Array.prototype.slice,
    WeakSet: typeof WeakSet === 'function' ? WeakSet : null,
    WeakMap: typeof WeakMap === 'function' ? WeakMap : null,
  };
  var ORIGINAL_CONSOLE = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  var MAIN_TO_BRIDGE = 'bugpin:main->bridge'; // == MSG.MAIN_TO_BRIDGE
  var MAX_STRING = 4000; // == LIMITS.MAX_STRING
  var MAX_DEPTH = 3;
  var MAX_KEYS = 50;
  var RATE_LIMIT_PER_SEC = 200;
  var VALID_LEVELS = { log: 1, info: 1, warn: 1, error: 1, debug: 1 };

  // Byte-for-byte identical to lib/redact.js `truncate` — this world cannot
  // import it, so the format is mirrored here (PROTOCOL §5).
  function truncate(str) {
    if (typeof str !== 'string' || str.length <= MAX_STRING) return str;
    return str.slice(0, MAX_STRING) + ' … (+' + (str.length - MAX_STRING) + ' chars)';
  }

  function describeNode(node) {
    try {
      var tag = node.tagName ? node.tagName.toLowerCase() : (node.nodeName || 'node');
      var id = node.id ? '#' + node.id : '';
      var cls = '';
      if (typeof node.className === 'string' && node.className.trim()) {
        cls = '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      return '<' + tag + id + cls + '>';
    } catch (err) {
      return '[Node]';
    }
  }

  /** Depth/key-capped, circular-safe JSON.stringify via a custom replacer. */
  function safeStringify(rootValue) {
    var seen = NATIVE.WeakSet ? new NATIVE.WeakSet() : null;
    var depthOf = NATIVE.WeakMap ? new NATIVE.WeakMap() : null;
    var keyCountOf = NATIVE.WeakMap ? new NATIVE.WeakMap() : null;

    function replacer(key, val) {
      if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
      if (val instanceof Error) return (val.name || 'Error') + ': ' + val.message;
      if (val && val.nodeType) return describeNode(val);
      if (val && typeof val === 'object' && seen && depthOf) {
        if (seen.has(val)) return '[Circular]';
        var parentDepth = key === '' ? -1 : (depthOf.has(this) ? depthOf.get(this) : 0);
        var depth = parentDepth + 1;
        if (depth > MAX_DEPTH) return NATIVE.isArray(val) ? '[Array]' : '[Object]';
        seen.add(val);
        depthOf.set(val, depth);
      }
      if (this && typeof this === 'object' && key !== '' && keyCountOf) {
        var count = (keyCountOf.get(this) || 0) + 1;
        keyCountOf.set(this, count);
        if (count > MAX_KEYS) return undefined;
      }
      return val;
    }

    try {
      var out = NATIVE.jsonStringify(rootValue, replacer);
      return out === undefined ? String(rootValue) : out;
    } catch (err) {
      return '[Unserializable]';
    }
  }

  function serializeArg(value) {
    try {
      if (typeof value === 'string') return value;
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (value instanceof Error) return (value.name || 'Error') + ': ' + value.message;
      if (value && value.nodeType) return describeNode(value);
      if (typeof value === 'object') return safeStringify(value);
      return String(value);
    } catch (err) {
      return '[Unserializable]';
    }
  }

  function extractStack(args) {
    for (var i = 0; i < args.length; i += 1) {
      if (args[i] instanceof Error && typeof args[i].stack === 'string') return args[i].stack;
    }
    return undefined;
  }

  function serializeArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i += 1) parts.push(serializeArg(args[i]));
    return parts.join(' ');
  }

  function post(payload) {
    try {
      NATIVE.postMessage({ source: MAIN_TO_BRIDGE, payload: payload }, '*');
    } catch (err) {
      // Never let capture break the page.
    }
  }

  // --- Rate limiting: 200 events/sec, coalesced beyond that. ---
  var windowStartTs = NATIVE.dateNow();
  var windowCount = 0;
  var suppressedInWindow = 0;

  function emit(kind, level, text, stack, url) {
    try {
      var now = NATIVE.dateNow();
      if (now - windowStartTs >= 1000) {
        if (suppressedInWindow > 0) {
          post({
            kind: 'console',
            level: 'warn',
            text: suppressedInWindow + ' console messages suppressed',
            stack: undefined,
            url: url,
            ts: now,
          });
        }
        windowStartTs = now;
        windowCount = 0;
        suppressedInWindow = 0;
      }
      windowCount += 1;
      if (windowCount > RATE_LIMIT_PER_SEC) {
        suppressedInWindow += 1;
        return;
      }
      post({
        kind: kind,
        level: VALID_LEVELS[level] ? level : 'log',
        text: truncate(text),
        stack: stack ? truncate(stack) : undefined,
        url: url,
        ts: now,
      });
    } catch (err) {
      // Swallow — capture must never throw into caller code.
    }
  }

  function patchConsoleMethod(name) {
    var original = ORIGINAL_CONSOLE[name];
    if (typeof original !== 'function') return;
    console[name] = function bugpinPatchedConsoleMethod() {
      var args = NATIVE.slice.call(arguments);
      try {
        emit('console', name, serializeArgs(args), extractStack(args), window.location.href);
      } catch (err) {
        // Swallow — always fall through to the original below.
      }
      return original.apply(this, arguments);
    };
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(patchConsoleMethod);

  NATIVE.addEventListener('error', function bugpinOnError(evt) {
    try {
      var err = evt && evt.error;
      var text = err ? (err.name || 'Error') + ': ' + err.message : (evt && evt.message) || 'Error';
      var stack = err && typeof err.stack === 'string'
        ? err.stack
        : (evt.filename || '') + ':' + (evt.lineno || 0) + ':' + (evt.colno || 0);
      emit('console', 'error', text, stack, window.location.href);
    } catch (e) {
      // Swallow.
    }
  }, true);

  NATIVE.addEventListener('unhandledrejection', function bugpinOnUnhandledRejection(evt) {
    try {
      var reason = evt && evt.reason;
      var text;
      var stack;
      if (reason instanceof Error) {
        text = (reason.name || 'Error') + ': ' + reason.message;
        stack = reason.stack;
      } else {
        text = 'Unhandled promise rejection: ' + serializeArg(reason);
        stack = undefined;
      }
      emit('console', 'error', text, stack, window.location.href);
    } catch (e) {
      // Swallow.
    }
  });
})();
