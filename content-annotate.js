/**
 * BugPin annotation overlay. Classic content script, ISOLATED world,
 * document_idle. Dormant until MSG.SET_MODE{annotating:true} arrives (or the
 * state fetched on load already says so). All UI lives in one closed
 * Shadow DOM host so it never leaks styles to (or reads styles from) the
 * page. See PROTOCOL.md §5.
 */
(async function bugpinAnnotate() {
  'use strict';

  // --- listener first, imports second ---------------------------------------
  // Everything below the `await` runs a macrotask later. A SET_MODE push that
  // lands in that gap (popup click or Cmd+Shift+E right as the page settles)
  // would find NO listener at all: the service worker's sendMessage rejects
  // with "Receiving end does not exist", setModeOnTab swallows it, and the tab
  // is left with annotate mode on in the store but no overlay on screen — with
  // nothing to re-trigger a catch-up. So the listener is registered
  // synchronously against mirrored lib/messages.js literals and buffers until
  // the modules are live.
  const SET_MODE_TYPE = 'bugpin:set-mode'; // == MSG.SET_MODE
  const RESTORE_PINS_TYPE = 'bugpin:restore-pins'; // == MSG.RESTORE_PINS
  const MAX_PENDING_MESSAGES = 50;

  let modulesReady = false;
  const pendingMessages = [];

  function applyRuntimeMessage(msg) {
    if (msg.type === SET_MODE_TYPE) setMode(Boolean(msg.annotating));
    else if (msg.type === RESTORE_PINS_TYPE) {
      restorePins(Array.isArray(msg.annotations) ? msg.annotations : []);
    }
  }

  function drainPendingMessages() {
    const queued = pendingMessages.splice(0, pendingMessages.length);
    for (const msg of queued) {
      try {
        applyRuntimeMessage(msg);
      } catch (err) {
        console.error('BugPin: queued message failed', err);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || (msg.type !== SET_MODE_TYPE && msg.type !== RESTORE_PINS_TYPE)) return undefined;
    if (!modulesReady) {
      pendingMessages.push(msg);
      if (pendingMessages.length > MAX_PENDING_MESSAGES) pendingMessages.shift();
      return undefined;
    }
    applyRuntimeMessage(msg);
    return undefined;
  });

  const [
    { MSG, LIMITS, STORAGE, DEFAULT_OPTIONS, UI_MARKER },
    { describeElement },
    { redactString, redactUrl, truncate },
    { placeBeside, placeAboveOrBelow, pinAnchorPoint },
  ] = await Promise.all([
    import(chrome.runtime.getURL('lib/messages.js')),
    import(chrome.runtime.getURL('lib/selector.js')),
    import(chrome.runtime.getURL('lib/redact.js')),
    import(chrome.runtime.getURL('lib/anchor.js')),
  ]);

  const HOST_ID = 'bugpin-annotate-root';

  const state = {
    annotating: false,
    frozen: false,
    host: null,
    shadow: null,
    elements: null,
    hoverEl: null,
    hoverRaf: 0,
    lastMouse: null,
    activeTarget: null,
    pins: [],
    pinRaf: 0,
    resizeObserver: null,
    savedCursor: undefined,
  };

  // ---- redaction (PROTOCOL §5: applied by the PRODUCER, before storage) ----

  let redactEnabled = DEFAULT_OPTIONS.redact;

  function watchRedactOption() {
    const key = STORAGE.OPTIONS;
    chrome.storage.local
      .get(key)
      .then((stored) => {
        const options = stored && stored[key];
        redactEnabled = options && typeof options.redact === 'boolean' ? options.redact : DEFAULT_OPTIONS.redact;
      })
      .catch(() => {
        redactEnabled = DEFAULT_OPTIONS.redact;
      });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[key]) return;
      const next = changes[key].newValue;
      redactEnabled = next && typeof next.redact === 'boolean' ? next.redact : DEFAULT_OPTIONS.redact;
    });
  }

  /** Free text (note, element text, attribute values, label). */
  function scrub(value) {
    if (typeof value !== 'string') return value;
    return truncate(redactString(value, redactEnabled), LIMITS.MAX_STRING);
  }

  /** URLs take the query-string rule so the path stays readable. */
  function scrubUrl(value) {
    if (typeof value !== 'string') return value;
    return truncate(redactUrl(value, redactEnabled), LIMITS.MAX_STRING);
  }

  /** `href` is a URL; everything else in attrs is free text. */
  function scrubAttrs(attrs) {
    const out = {};
    for (const [name, value] of Object.entries(attrs || {})) {
      out[name] = name === 'href' || name === 'src' ? scrubUrl(value) : scrub(value);
    }
    return out;
  }

  // ---- messaging ---------------------------------------------------------

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  // ---- shadow host + static overlay pieces -------------------------------

  function createShadowHost() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute(UI_MARKER, '');
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
    return { host, shadow };
  }

  function createHoverBox() {
    const el = document.createElement('div');
    el.className = 'hover-box';
    el.hidden = true;
    return el;
  }

  function createTooltip() {
    const el = document.createElement('div');
    el.className = 'tooltip';
    el.hidden = true;
    return el;
  }

  function createNoteBox() {
    const box = document.createElement('div');
    box.className = 'notebox';
    box.hidden = true;

    const textarea = document.createElement('textarea');
    textarea.placeholder = "What's wrong here? e.g. delete this";
    textarea.addEventListener('keydown', onTextareaKeyDown);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Enter to save · Shift+Enter newline · Esc cancel';

    const error = document.createElement('div');
    error.className = 'error';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => closeNoteBox({ keepText: false }));
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', submitNote);
    actions.append(cancelBtn, saveBtn);

    box.append(textarea, hint, error, actions);
    return { box, textarea, error, saveBtn };
  }

  function createChip() {
    const el = document.createElement('div');
    el.className = 'chip';
    el.hidden = true;
    el.addEventListener('click', () => exitAnnotateMode());
    return el;
  }

  function buildOverlayElements(shadow) {
    const hoverBox = createHoverBox();
    const tooltip = createTooltip();
    const { box: noteBox, textarea, error, saveBtn } = createNoteBox();
    const pinsLayer = document.createElement('div');
    pinsLayer.className = 'pins-layer';
    const chip = createChip();
    shadow.append(hoverBox, tooltip, noteBox, pinsLayer, chip);
    return { hoverBox, tooltip, noteBox, textarea, error, saveBtn, pinsLayer, chip };
  }

  function ensureHost() {
    if (state.host) return;
    const { host, shadow } = createShadowHost();
    state.host = host;
    state.shadow = shadow;
    state.elements = buildOverlayElements(shadow);
    ensureResizeObserver();
    window.addEventListener('scroll', schedulePinLayout, { capture: true, passive: true });
  }

  function isUiTarget(node) {
    return !!state.host && node === state.host;
  }

  // ---- mode lifecycle -----------------------------------------------------

  function setMode(annotating) {
    if (annotating === state.annotating) return;
    state.annotating = annotating;
    if (annotating) activate();
    else deactivate();
  }

  function activate() {
    ensureHost();
    state.savedCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onMouseMove, { capture: true });
    document.addEventListener('click', onClickCapture, { capture: true });
    document.addEventListener('keydown', onGlobalKeyDown, { capture: true });
    state.elements.chip.hidden = false;
    updateStatusChip();
  }

  function deactivate() {
    document.removeEventListener('mousemove', onMouseMove, { capture: true });
    document.removeEventListener('click', onClickCapture, { capture: true });
    document.removeEventListener('keydown', onGlobalKeyDown, { capture: true });
    document.documentElement.style.cursor = state.savedCursor || '';
    clearHoverVisuals();
    if (state.frozen) closeNoteBox({ keepText: false });
    if (state.elements) state.elements.chip.hidden = true;
  }

  async function exitAnnotateMode() {
    setMode(false);
    try {
      await sendMessage({ type: MSG.TOGGLE_ANNOTATE, on: false });
    } catch (err) {
      // Best-effort: local UI already exited; the service worker resyncs
      // this tab's mode on the next STATE_REQUEST regardless.
      console.error('BugPin: failed to notify service worker of exit', err);
    }
  }

  function teardown() {
    deactivate();
    if (state.resizeObserver) state.resizeObserver.disconnect();
    window.removeEventListener('scroll', schedulePinLayout, { capture: true });
    if (state.host) state.host.remove();
    state.host = null;
    state.shadow = null;
    state.elements = null;
    state.pins = [];
  }

  // ---- hover ----------------------------------------------------------------

  function onMouseMove(e) {
    state.lastMouse = { x: e.clientX, y: e.clientY };
    if (state.hoverRaf) return;
    state.hoverRaf = requestAnimationFrame(() => {
      state.hoverRaf = 0;
      if (!state.annotating || state.frozen || !state.lastMouse) return;
      const { x, y } = state.lastMouse;
      const el = document.elementFromPoint(x, y);
      if (!el || isUiTarget(el)) {
        clearHoverVisuals();
        return;
      }
      paintHover(el);
    });
  }

  function paintHover(el) {
    if (el === state.hoverEl) return;
    state.hoverEl = el;
    const rect = el.getBoundingClientRect();
    const info = describeElement(el);
    const { hoverBox, tooltip } = state.elements;
    hoverBox.classList.remove('solid');
    positionBox(hoverBox, rect);
    hoverBox.hidden = false;
    positionTooltip(tooltip, rect, `${info.label} · ${info.selector}`);
    tooltip.hidden = false;
  }

  function clearHoverVisuals() {
    state.hoverEl = null;
    if (!state.elements) return;
    state.elements.hoverBox.hidden = true;
    state.elements.tooltip.hidden = true;
  }

  function positionBox(el, rect) {
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  function positionTooltip(el, rect, text) {
    el.textContent = text;
    const size = { width: el.offsetWidth || 200, height: el.offsetHeight || 24 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const pos = placeAboveOrBelow({ anchor: rect, size, viewport, margin: 8 });
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  // ---- click -> freeze -> note box -----------------------------------------

  function onClickCapture(e) {
    if (!state.annotating) return;
    if (isUiTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (state.frozen) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isUiTarget(el)) return;
    freezeAndOpenNoteBox(el);
  }

  function freezeAndOpenNoteBox(el) {
    state.frozen = true;
    state.activeTarget = el;
    const rect = el.getBoundingClientRect();
    const { hoverBox, tooltip } = state.elements;
    hoverBox.classList.add('solid');
    positionBox(hoverBox, rect);
    hoverBox.hidden = false;
    tooltip.hidden = true;
    openNoteBox(rect);
  }

  function openNoteBoxAt(rect) {
    const { noteBox } = state.elements;
    const size = { width: noteBox.offsetWidth || 280, height: noteBox.offsetHeight || 140 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const pos = placeBeside({ anchor: rect, size, viewport, margin: 10 });
    noteBox.style.left = `${pos.x}px`;
    noteBox.style.top = `${pos.y}px`;
  }

  function openNoteBox(rect) {
    const { noteBox, textarea } = state.elements;
    noteBox.hidden = false;
    textarea.value = '';
    showBoxError('');
    openNoteBoxAt(rect);
    requestAnimationFrame(() => textarea.focus());
  }

  function closeNoteBox({ keepText }) {
    state.frozen = false;
    state.activeTarget = null;
    const { noteBox, textarea, hoverBox, tooltip } = state.elements;
    noteBox.hidden = true;
    if (!keepText) textarea.value = '';
    hoverBox.classList.remove('solid');
    hoverBox.hidden = true;
    tooltip.hidden = true;
    state.hoverEl = null;
  }

  /**
   * Hides the note box + hover highlight but keeps the freeze and the pin
   * layer, so the screenshot the service worker takes on MSG.ANNOTATION shows
   * the page, not our input (PROTOCOL §5).
   */
  /**
   * Hides every piece of BugPin's own UI — including the status chip — so the
   * screenshot the service worker is about to take shows the page, not the tool.
   */
  function hideOverlayForCapture() {
    const { noteBox, hoverBox, tooltip, chip } = state.elements;
    noteBox.hidden = true;
    hoverBox.classList.remove('solid');
    hoverBox.hidden = true;
    tooltip.hidden = true;
    chip.hidden = true;
  }

  /** Brings the note box back with its text after a failed save. */
  function reopenNoteBox(target, note, message) {
    const { noteBox, textarea } = state.elements;
    noteBox.hidden = false;
    textarea.value = note;
    showBoxError(message);
    if (target && target.isConnected) openNoteBoxAt(target.getBoundingClientRect());
    requestAnimationFrame(() => textarea.focus());
  }

  /** Resolves once the browser has painted the hidden overlay. */
  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  function showBoxError(message) {
    state.elements.error.textContent = message || '';
  }

  function onTextareaKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitNote();
    }
  }

  function onGlobalKeyDown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (state.frozen) closeNoteBox({ keepText: false });
    else exitAnnotateMode();
  }

  // ---- save -----------------------------------------------------------------

  function buildAnnotationPayload(el, note) {
    const info = describeElement(el);
    const rect = el.getBoundingClientRect();
    return {
      note: scrub(note),
      // selector/xpath are truncated but never redacted — they must stay
      // valid for pin restore and the generated Playwright spec.
      selector: truncate(info.selector, LIMITS.MAX_STRING),
      xpath: truncate(info.xpath, LIMITS.MAX_STRING),
      label: scrub(info.label),
      tagName: info.tagName,
      attrs: scrubAttrs(info.attrs),
      text: scrub(info.text),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      devicePixelRatio: window.devicePixelRatio,
      url: scrubUrl(location.href),
      ts: Date.now(),
    };
  }

  /**
   * After an extension reload/update this content script's `chrome.runtime` is
   * permanently dead, so "Try again" is advice that can never work — tell the
   * user to reload instead. Same two error substrings content-bridge.js treats
   * as recoverable.
   */
  function saveErrorMessage(err) {
    const message = (err && err.message) || '';
    if (message.includes('Extension context invalidated') || message.includes('Receiving end does not exist')) {
      return 'BugPin was updated — reload the page to keep annotating.';
    }
    return message || 'Could not save note. Try again.';
  }

  async function submitNote() {
    const { textarea, saveBtn } = state.elements;
    const note = textarea.value;
    if (!note.trim()) {
      showBoxError("Write a note before saving.");
      return;
    }
    const target = state.activeTarget;
    if (!target) {
      showBoxError('Lost the element — pick it again.');
      return;
    }
    showBoxError('');
    saveBtn.disabled = true;
    // Build the payload (rect included) while the element is still frozen,
    // then hide the input BEFORE the service worker screenshots the tab.
    const annotation = buildAnnotationPayload(target, note);
    hideOverlayForCapture();
    try {
      await nextPaint();
      const response = await sendMessage({ type: MSG.ANNOTATION, annotation });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Save failed. Try again.');
      }
      placePin(response.index, target, note);
      closeNoteBox({ keepText: false });
    } catch (err) {
      reopenNoteBox(target, note, saveErrorMessage(err));
    } finally {
      saveBtn.disabled = false;
      if (state.annotating) state.elements.chip.hidden = false;
    }
  }

  // ---- pins -------------------------------------------------------------

  function placePin(index, target, note) {
    const badge = document.createElement('div');
    badge.className = 'pin';
    badge.textContent = String(index);
    badge.title = note;
    state.elements.pinsLayer.appendChild(badge);
    state.pins = [...state.pins, { index, target, note, badge }];
    ensureResizeObserver().observe(target);
    updateStatusChip();
    schedulePinLayout();
  }

  function schedulePinLayout() {
    if (state.pinRaf || !state.elements) return;
    state.pinRaf = requestAnimationFrame(() => {
      state.pinRaf = 0;
      layoutPins();
    });
  }

  function layoutPins() {
    if (!state.elements) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    for (const pin of state.pins) {
      if (!pin.target.isConnected) {
        pin.badge.hidden = true;
        continue;
      }
      const rect = pin.target.getBoundingClientRect();
      const pos = pinAnchorPoint({ rect, viewport });
      pin.badge.hidden = false;
      pin.badge.style.left = `${pos.x}px`;
      pin.badge.style.top = `${pos.y}px`;
    }
  }

  function ensureResizeObserver() {
    if (state.resizeObserver) return state.resizeObserver;
    state.resizeObserver = new ResizeObserver(() => schedulePinLayout());
    state.resizeObserver.observe(document.documentElement);
    return state.resizeObserver;
  }

  function updateStatusChip() {
    if (!state.elements) return;
    const n = state.pins.length;
    state.elements.chip.textContent = `BugPin · ${n} note${n === 1 ? '' : 's'} · Esc to exit`;
  }

  function safeQuerySelector(selector) {
    try {
      return document.querySelector(selector);
    } catch (err) {
      console.error('BugPin: invalid stored selector', selector, err);
      return null;
    }
  }

  function restorePins(annotations) {
    ensureHost();
    for (const pin of state.pins) pin.badge.remove();
    state.pins = [];
    for (const a of annotations) {
      const el = safeQuerySelector(a.selector);
      if (el) placePin(a.index, el, a.note);
    }
    layoutPins();
  }

  // ---- overlay styles -----------------------------------------------------

  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const OVERLAY_CSS = `
    * { box-sizing: border-box; }
    .hover-box { position: absolute; pointer-events: none; border: 2px solid #3b82f6; border-radius: 3px; background: rgba(59,130,246,0.08); }
    .hover-box.solid { background: rgba(59,130,246,0.16); }
    .tooltip { position: absolute; pointer-events: none; font: 12px/1.4 ${FONT}; background: #18181b; color: #f4f4f5; padding: 4px 8px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.35); max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .notebox { position: absolute; pointer-events: auto; width: 280px; background: #18181b; color: #f4f4f5; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); padding: 10px; font: 13px/1.4 ${FONT}; }
    .notebox textarea { width: 100%; min-height: 64px; resize: vertical; background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 4px; padding: 6px 8px; font: inherit; }
    .notebox textarea:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
    .notebox .hint { margin-top: 6px; font-size: 11px; color: #a1a1aa; }
    .notebox .error { margin-top: 6px; font-size: 11px; color: #f87171; min-height: 0; }
    .notebox .actions { margin-top: 8px; display: flex; justify-content: flex-end; gap: 8px; }
    .notebox button { font: inherit; border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer; }
    .notebox .save { background: #3b82f6; color: #fff; }
    .notebox .save:disabled { opacity: 0.6; cursor: default; }
    .notebox .cancel { background: #3f3f46; color: #f4f4f5; }
    .pin { position: absolute; pointer-events: none; width: 20px; height: 20px; border-radius: 50%; background: #ef4444; color: #fff; font: 11px/20px ${FONT}; text-align: center; font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: default; }
    .chip { position: absolute; pointer-events: auto; right: 12px; bottom: 12px; background: #18181b; color: #f4f4f5; font: 12px ${FONT}; padding: 6px 10px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.35); cursor: pointer; user-select: none; }
  `;

  // ---- bootstrap ------------------------------------------------------------

  window.addEventListener('pagehide', teardown, { once: true });

  watchRedactOption();

  // Modules are live: replay anything the listener buffered during the import,
  // then let the service worker's current state win as the final say.
  modulesReady = true;
  drainPendingMessages();

  try {
    const initialState = await sendMessage({ type: MSG.STATE_REQUEST });
    if (initialState && initialState.annotating) setMode(true);
  } catch (err) {
    console.error('BugPin: failed to fetch initial state', err);
  }
})();
