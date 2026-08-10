/**
 * BugPin — ISOLATED world bridge. Classic script, document_start.
 *
 * Receives MAIN-world console/error events via window.postMessage, captures
 * E2E steps (click/input/change/submit/key), and forwards everything to the
 * service worker as MSG.EVENT. Owns nothing visual — see PROTOCOL.md §1.
 *
 * lib/* modules are only reachable via dynamic import(chrome.runtime.getURL)
 * per PROTOCOL.md §1, so everything captured before that resolves is queued
 * in `pendingTasks` and replayed in order once ready.
 *
 * lib/redact.js exports used here: `redactString(str, enabled)`,
 * `shouldRedactInputValue(el)`, `truncate(str, max)`.
 * lib/selector.js export used here: `describeElement(el)`.
 */
(function bugpinBridge() {
  'use strict';

  if (window.__bugpinBridgeInjected__) return;
  window.__bugpinBridgeInjected__ = true;

  // Mirrors lib/messages.js literals so the message/onMessage listeners can
  // filter before the dynamic import resolves.
  var MAIN_TO_BRIDGE = 'bugpin:main->bridge';
  var SET_MODE_TYPE = 'bugpin:set-mode';
  var UI_MARKER_ATTR = 'data-bugpin-ui';
  var DEFAULT_MAX_STRING = 4000;
  var INPUT_DEBOUNCE_MS = 500;
  var MAX_PENDING_TASKS = 1000;
  var TRACKED_KEYS = { Enter: 1, Escape: 1, Tab: 1 };
  var VALID_LEVELS = { log: 1, info: 1, warn: 1, error: 1, debug: 1 };

  var libs = null; // { MSG, LIMITS, STORAGE, redact, selector }
  var libsReady = false;
  var stateKnown = false;
  var state = { recording: false, annotating: false };
  var redactEnabled = true; // Options.redact, refreshed from storage
  var pendingTasks = [];
  var inputDebounceTimers = new WeakMap();

  function whenReady(task) {
    if (libsReady && stateKnown) {
      task();
      return;
    }
    pendingTasks.push(task);
    if (pendingTasks.length > MAX_PENDING_TASKS) pendingTasks.shift();
  }

  function flushPending() {
    var tasks = pendingTasks.splice(0, pendingTasks.length);
    for (var i = 0; i < tasks.length; i += 1) {
      try {
        tasks[i]();
      } catch (err) {
        console.error('[bugpin] pending task failed', err);
      }
    }
  }

  function genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Redact through the shared lib (no truncation). */
  function redactOnly(str) {
    if (!libs) return str;
    return libs.redact.redactString(str, redactEnabled);
  }

  function maxString() {
    return libs && libs.LIMITS ? libs.LIMITS.MAX_STRING : DEFAULT_MAX_STRING;
  }

  /** Redact + truncate through the shared lib so every producer agrees. */
  function scrub(str) {
    if (!libs) return str;
    return libs.redact.truncate(redactOnly(str), maxString());
  }

  /**
   * URLs get the query-string rule (keys kept, sensitive values masked), not
   * the free-text rule — PROTOCOL §5. Every `url` field this bridge emits goes
   * through here: a page like /reset?token=… would otherwise carry the token
   * into report.md via the console/step events, even though the SAME url is
   * correctly redacted when it arrives as a network or nav event.
   */
  function scrubUrl(url) {
    if (!libs || typeof url !== 'string') return url;
    return libs.redact.truncate(libs.redact.redactUrl(url, redactEnabled), maxString());
  }

  /** Wraps chrome.runtime.sendMessage; survives an asleep/torn-down worker. */
  function safeSendMessage(message, attempt) {
    var tryNumber = attempt || 0;
    return Promise.resolve()
      .then(function () {
        return chrome.runtime.sendMessage(message);
      })
      .catch(function (err) {
        var msg = (err && err.message) || String(err);
        var recoverable = msg.indexOf('Extension context invalidated') !== -1
          || msg.indexOf('Receiving end does not exist') !== -1;
        if (recoverable && tryNumber < 1) {
          return new Promise(function (resolve) {
            setTimeout(resolve, 50);
          }).then(function () {
            return safeSendMessage(message, tryNumber + 1);
          });
        }
        return undefined; // dropped silently after one retry
      });
  }

  function sendEventMessage(event) {
    var MSG = libs.MSG;
    safeSendMessage({ type: MSG.EVENT, event: event });
  }

  // --- console/error bridging from MAIN world ---

  function normalizeLevel(level) {
    return VALID_LEVELS[level] ? level : 'log';
  }

  function processConsolePayload(payload) {
    if (!state.recording) return;
    var rawText = typeof payload.text === 'string' ? payload.text : String(payload.text || '');
    var rawStack = typeof payload.stack === 'string' ? payload.stack : undefined;
    // The MAIN world already applied the PROTOCOL §5 truncation (it alone
    // knows the original length), so only redact here — re-truncating would
    // nest a second "… (+N chars)" suffix with a bogus N.
    var text = redactOnly(rawText);
    var stack = rawStack ? redactOnly(rawStack) : undefined;
    var url = scrubUrl(typeof payload.url === 'string' ? payload.url : window.location.href);
    var event = {
      id: genId(),
      ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
      kind: 'console',
      level: normalizeLevel(payload.level),
      text: text,
      stack: stack,
      url: url,
    };
    sendEventMessage(event);
  }

  window.addEventListener('message', function bugpinOnWindowMessage(evt) {
    if (evt.source !== window) return;
    var data = evt.data;
    if (!data || data.source !== MAIN_TO_BRIDGE || !data.payload) return;
    var payload = data.payload;
    whenReady(function () {
      processConsolePayload(payload);
    });
  });

  // --- E2E step capture ---

  function isBugpinUi(el) {
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest('[' + UI_MARKER_ATTR + ']');
  }

  function readElementValue(el) {
    if ('value' in el && typeof el.value === 'string') return el.value;
    if (el.isContentEditable) return el.textContent || '';
    return '';
  }

  function resolveValue(el) {
    if (libs.redact.shouldRedactInputValue(el)) return '«redacted»';
    return scrub(readElementValue(el));
  }

  function emitStep(action, el, value) {
    try {
      var info = libs.selector.describeElement(el);
      var base = {
        id: genId(),
        ts: Date.now(),
        kind: 'step',
        action: action,
        // selector/xpath are truncated but never redacted: they have to stay
        // valid for pin restore and the Playwright spec.
        selector: libs.redact.truncate(info.selector, maxString()),
        xpath: libs.redact.truncate(info.xpath, maxString()),
        label: scrub(info.label),
        url: scrubUrl(window.location.href),
      };
      var event = value === undefined ? base : Object.assign({}, base, { value: value });
      sendEventMessage(event);
    } catch (err) {
      console.error('[bugpin] failed to capture step event', err);
    }
  }

  function guardedTarget(evt) {
    var el = evt.target;
    if (!(el instanceof Element) || isBugpinUi(el)) return null;
    return el;
  }

  /**
   * Steps are captured only while recording AND not annotating: in annotate
   * mode the click belongs to the overlay, not to the repro (PROTOCOL §5).
   */
  function shouldCaptureStep() {
    return state.recording && !state.annotating;
  }

  document.addEventListener('click', function bugpinOnClick(evt) {
    var el = guardedTarget(evt);
    if (!el) return;
    whenReady(function () {
      if (!shouldCaptureStep()) return;
      emitStep('click', el, undefined);
    });
  }, { capture: true, passive: true });

  document.addEventListener('input', function bugpinOnInput(evt) {
    var el = guardedTarget(evt);
    if (!el) return;
    whenReady(function () {
      if (!shouldCaptureStep()) return;
      scheduleDebouncedInput(el);
    });
  }, { capture: true, passive: true });

  function scheduleDebouncedInput(el) {
    var existing = inputDebounceTimers.get(el);
    if (existing) clearTimeout(existing);
    var timer = setTimeout(function () {
      inputDebounceTimers.delete(el);
      emitStep('input', el, resolveValue(el));
    }, INPUT_DEBOUNCE_MS);
    inputDebounceTimers.set(el, timer);
  }

  document.addEventListener('change', function bugpinOnChange(evt) {
    var el = guardedTarget(evt);
    if (!el) return;
    whenReady(function () {
      if (!shouldCaptureStep()) return;
      var pending = inputDebounceTimers.get(el);
      if (pending) {
        clearTimeout(pending);
        inputDebounceTimers.delete(el);
      }
      emitStep('change', el, resolveValue(el));
    });
  }, { capture: true, passive: true });

  document.addEventListener('submit', function bugpinOnSubmit(evt) {
    var el = guardedTarget(evt);
    if (!el) return;
    whenReady(function () {
      if (!shouldCaptureStep()) return;
      emitStep('submit', el, undefined);
    });
  }, { capture: true, passive: true });

  document.addEventListener('keydown', function bugpinOnKeydown(evt) {
    if (!TRACKED_KEYS[evt.key]) return;
    var el = guardedTarget(evt);
    if (!el) return;
    var key = evt.key;
    whenReady(function () {
      if (!shouldCaptureStep()) return;
      emitStep('key', el, key);
    });
  }, { capture: true, passive: true });

  // --- state lifecycle ---

  function requestInitialState() {
    var MSG = libs.MSG;
    safeSendMessage({ type: MSG.STATE_REQUEST }).then(function (resp) {
      stateKnown = true;
      if (resp) state = { recording: !!resp.recording, annotating: !!resp.annotating };
      flushPending();
    });
  }

  function refreshState() {
    var MSG = libs.MSG;
    safeSendMessage({ type: MSG.STATE_REQUEST }).then(function (resp) {
      if (resp) state = { recording: !!resp.recording, annotating: !!resp.annotating };
    });
  }

  function handleSetMode(message) {
    state = Object.assign({}, state, { annotating: !!message.annotating });
    if (libsReady) {
      refreshState();
    } else {
      whenReady(refreshState);
    }
  }

  chrome.runtime.onMessage.addListener(function bugpinOnRuntimeMessage(message) {
    if (!message || message.type !== SET_MODE_TYPE) return undefined;
    handleSetMode(message);
    return undefined;
  });

  /** Options.redact (PROTOCOL §6) decides whether producers scrub secrets. */
  function watchRedactOption(messagesMod) {
    var key = messagesMod.STORAGE.OPTIONS;
    var fallback = messagesMod.DEFAULT_OPTIONS.redact;
    chrome.storage.local.get(key).then(function (stored) {
      var options = stored && stored[key];
      redactEnabled = options && typeof options.redact === 'boolean' ? options.redact : fallback;
    }).catch(function () {
      redactEnabled = fallback;
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[key]) return;
      var next = changes[key].newValue;
      redactEnabled = next && typeof next.redact === 'boolean' ? next.redact : fallback;
    });
  }

  function init() {
    Promise.all([
      import(chrome.runtime.getURL('lib/messages.js')),
      import(chrome.runtime.getURL('lib/redact.js')),
      import(chrome.runtime.getURL('lib/selector.js')),
    ]).then(function (mods) {
      var messagesMod = mods[0];
      var redactMod = mods[1];
      var selectorMod = mods[2];
      libs = {
        MSG: messagesMod.MSG,
        LIMITS: messagesMod.LIMITS,
        STORAGE: messagesMod.STORAGE,
        redact: redactMod,
        selector: selectorMod,
      };
      libsReady = true;
      watchRedactOption(messagesMod);
      requestInitialState();
    }).catch(function (err) {
      console.error('[bugpin] bridge failed to load lib modules', err);
    });
  }

  init();
})();
