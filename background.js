/**
 * BugPin MV3 service worker. Only place chrome.* session logic lives.
 *
 * Collaborator APIs actually exported by the shared modules:
 *
 *   lib/capture-store.js
 *     createStore({ persist, now?, randomId?, onError?, maxEvents? })
 *       .hydrate(session: Session|null): Session|null   // SW wake
 *       .startSession({ tabId, startUrl, system }): Session
 *       .stopSession(): Session|null
 *       .discardSession(): null
 *       .getSession(): Session|null
 *       .getTabId(): number|null
 *       .isRecording(): boolean
 *       .setAnnotating(on: boolean): Session            // throws with no session
 *       .setMaxEvents(n: number): Session|null
 *       .appendEvent(event): Event|null                 // null with no session
 *       .addAnnotation(annotationIn): AnnotationOut     // THROWS when capped / no session
 *       .attachShots(index, { full, element }): AnnotationOut
 *       .toState(): SessionState
 *       .serialize(): Session|null
 *   lib/export.js
 *     buildExport(session): { folder: string, files: { path, content }[] }
 *   lib/redact.js
 *     redactUrl(url: string, enabled: boolean): string
 *
 * Persistence (PROTOCOL §5) is debounced ≤ 1s here and flushed before export.
 */

import { MSG, STORAGE, DEFAULT_OPTIONS } from './lib/messages.js';
import { createStore } from './lib/capture-store.js';
import { buildExport, claimFolder } from './lib/export.js';
import { redactUrl } from './lib/redact.js';
import { createNetworkCapture } from './lib/network-capture.js';
import { captureAnnotationShots } from './lib/shots.js';
import { writeExportFolder } from './lib/downloads.js';

const BADGE_RECORDING_COLOR = '#F59E0B';
const BADGE_ANNOTATING_COLOR = '#DC2626';
const PERSIST_DEBOUNCE_MS = 400; // PROTOCOL §5: ≤ 1s

let currentOptions = { ...DEFAULT_OPTIONS };

/** Debounced chrome.storage writer with an awaitable flush (PROTOCOL §5). */
function createPersister() {
  let timer = null;
  let queued = null;
  let hasQueued = false;
  let settled = Promise.resolve(); // tracks the last write; NEVER rejects
  let lastError = null;

  function writeNow(session) {
    const write = session
      ? chrome.storage.local.set({ [STORAGE.SESSION]: session })
      : chrome.storage.local.remove(STORAGE.SESSION);
    // The tracked promise must absorb its own rejection. A rejected promise
    // parked here (one quota/disk error is enough) used to poison every later
    // flush() — so Stop / Discard / Export kept failing long after the
    // transient error, with only a service-worker console.error as evidence.
    settled = Promise.resolve(write).then(
      () => {
        lastError = null;
      },
      (err) => {
        lastError = err;
        console.error('[bugpin] persist failed', err);
      },
    );
    return settled;
  }

  function persist(session) {
    queued = session;
    hasQueued = true;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const pending = queued;
      hasQueued = false;
      queued = null;
      writeNow(pending);
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Writes anything still queued and waits for the storage write to settle.
   * Never rejects: PROTOCOL §2 requires STOP/DISCARD to always resolve to a
   * SessionState. Resolves to the last write error (or null) so callers that
   * care can report it.
   */
  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (hasQueued) {
      const pending = queued;
      hasQueued = false;
      queued = null;
      writeNow(pending);
    }
    await settled;
    return lastError;
  }

  return { persist, flush, getLastError: () => lastError };
}

const persister = createPersister();

const store = createStore({
  persist: (session) => persister.persist(session),
  onError: (err) => console.error('[bugpin] store persist error', err),
});

const networkCapture = createNetworkCapture({
  onEvent: (event) => store.appendEvent(event),
  getTabId: () => store.getTabId(),
  getOptions: () => currentOptions,
});

// --- registration (synchronous, top-level: MV3 requires this to not miss events) ---

chrome.runtime.onMessage.addListener(onMessage);
chrome.commands.onCommand.addListener(onCommand);
chrome.storage.onChanged.addListener(onStorageChanged);
chrome.tabs.onRemoved.addListener(onTabRemoved);

const readyPromise = initialize();

// --- startup ---

async function initialize() {
  const stored = await chrome.storage.local.get([STORAGE.SESSION, STORAGE.OPTIONS]);
  currentOptions = { ...DEFAULT_OPTIONS, ...(stored[STORAGE.OPTIONS] || {}) };
  store.hydrate(stored[STORAGE.SESSION] || null);
  applyMaxEventsOption();
  if (store.isRecording()) networkCapture.attach();
  updateBadge();
}

/** Options.maxEvents (PROTOCOL §6) drives the store's ring buffer. */
function applyMaxEventsOption() {
  const max = Number(currentOptions.maxEvents);
  if (!Number.isFinite(max) || max <= 0) return;
  try {
    store.setMaxEvents(max);
  } catch (err) {
    console.warn('[bugpin] ignoring invalid maxEvents option', err);
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'local' || !changes[STORAGE.OPTIONS]) return;
  currentOptions = { ...DEFAULT_OPTIONS, ...(changes[STORAGE.OPTIONS].newValue || {}) };
  applyMaxEventsOption();
}

// --- badge ---

function updateBadge() {
  const state = store.toState();
  if (state.annotating) {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_ANNOTATING_COLOR });
    chrome.action.setBadgeText({ text: String(state.annotationCount) });
  } else if (state.recording) {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_RECORDING_COLOR });
    chrome.action.setBadgeText({ text: 'REC' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// --- system info / session start ---

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** Executed inside the tab via chrome.scripting.executeScript. */
function collectPageSystemInfo() {
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
    devicePixelRatio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    platform: navigator.platform,
  };
}

function fallbackSystemInfo() {
  return {
    viewport: { width: 0, height: 0 },
    screen: { width: 0, height: 0 },
    devicePixelRatio: 1,
    timezone: 'UTC',
    language: navigator.language,
    platform: 'unknown',
  };
}

async function gatherSystemInfo(tab) {
  const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  const base = {
    capturedAt: new Date().toISOString(),
    startUrl: tab.url || '',
    userAgent: navigator.userAgent,
    extensionVersion: chrome.runtime.getManifest().version,
    chromeVersion: chromeMatch ? chromeMatch[1] : 'unknown',
  };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageSystemInfo,
    });
    return { ...base, ...result };
  } catch (err) {
    console.warn('[bugpin] system info injection failed, using fallback', err);
    return { ...base, ...fallbackSystemInfo() };
  }
}

async function setModeOnTab(tabId, annotating) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.SET_MODE, annotating });
  } catch {
    // content script not present (e.g. chrome:// tab) — not fatal
  }
}

// --- session lifecycle handlers ---

async function handleStart() {
  const tab = await getActiveTab();
  if (!tab) throw new Error('no active tab');
  const system = await gatherSystemInfo(tab);
  // The session about to be replaced is unreachable from here on, so its
  // screenshot blobs would sit in chrome.storage.local forever — only Discard
  // used to clear them, and base64 JPEGs are what exhausts the quota.
  await clearShotKeys(store.getSession());
  // Re-attaching matters: the webRequest filter pins the tabId at attach time,
  // so a restart on a different tab must tear the old listeners down first.
  networkCapture.detach();
  store.startSession({
    tabId: tab.id,
    startUrl: redactUrl(tab.url || '', currentOptions.redact),
    system,
  });
  applyMaxEventsOption();
  networkCapture.attach();
  await setModeOnTab(tab.id, false);
  updateBadge();
  return store.toState();
}

async function handleStop() {
  const tabId = store.getTabId();
  if (store.isRecording()) store.setAnnotating(false);
  store.stopSession();
  networkCapture.detach();
  await persister.flush();
  await setModeOnTab(tabId, false);
  updateBadge();
  return store.toState();
}

async function handleToggleAnnotate(message) {
  const explicit = typeof message?.on === 'boolean' ? message.on : null;
  const next = explicit === null ? !store.toState().annotating : explicit;
  // PROTOCOL §5: turning annotate ON without a session starts one implicitly.
  if (next && !store.isRecording()) await handleStart();
  if (!store.isRecording()) return store.toState();
  store.setAnnotating(next);
  await setModeOnTab(store.getTabId(), next);
  updateBadge();
  return store.toState();
}

async function clearShotKeys(session) {
  if (!session) return;
  const keys = (session.annotations || []).map((a) => `${STORAGE.SHOT_PREFIX}${a.index}`);
  if (!keys.length) return;
  try {
    await chrome.storage.local.remove(keys);
  } catch (err) {
    // Best-effort cleanup: never let it break Start/Discard.
    console.error('[bugpin] could not clear screenshot blobs', err);
  }
}

async function handleDiscard() {
  networkCapture.detach();
  const tabId = store.getTabId();
  const session = store.getSession();
  store.discardSession();
  await persister.flush();
  await clearShotKeys(session);
  await chrome.storage.local.remove(STORAGE.SESSION);
  await setModeOnTab(tabId, false);
  updateBadge();
  return store.toState();
}

// --- event / annotation capture ---

async function handleEvent(message, sender) {
  // PROTOCOL §5: capture is bound to exactly one tab and only while recording.
  if (!store.isRecording()) return { ok: false };
  if (!sender.tab || sender.tab.id !== store.getTabId()) return { ok: false };
  if (!message.event) return { ok: false };
  store.appendEvent(message.event);
  return { ok: true };
}

function shotPath(index, kind, dataUrl) {
  if (!dataUrl) return null;
  return `shots/${String(index).padStart(2, '0')}-${kind}.jpg`;
}

async function captureAndAttachShots(annotation) {
  try {
    const { full, element } = await captureAnnotationShots({
      tabId: store.getTabId(),
      annotation,
      options: currentOptions,
    });
    const fullPath = shotPath(annotation.index, 'full', full);
    const elementPath = shotPath(annotation.index, 'element', element);
    if (full || element) {
      await chrome.storage.local.set({
        [`${STORAGE.SHOT_PREFIX}${annotation.index}`]: { full, element },
      });
    }
    store.attachShots(annotation.index, { full: fullPath, element: elementPath });
  } catch (err) {
    console.error('[bugpin] shot capture failed, recording as null', err);
    try {
      store.attachShots(annotation.index, { full: null, element: null });
    } catch (attachErr) {
      console.error('[bugpin] could not record null shots', attachErr);
    }
  }
}

async function handleAnnotation(message, sender) {
  if (!store.isRecording()) return { ok: false, index: null, error: 'no active session' };
  if (!sender.tab || sender.tab.id !== store.getTabId()) {
    return { ok: false, index: null, error: 'annotation from an unbound tab' };
  }
  if (!message.annotation) return { ok: false, index: null, error: 'missing annotation payload' };
  // addAnnotation THROWS when capped / session-less, and already appends the
  // PROTOCOL §3 'annotation' marker event itself — do not append a second one.
  let created;
  try {
    created = store.addAnnotation(message.annotation);
  } catch (err) {
    return { ok: false, index: null, error: err.message || String(err) };
  }
  updateBadge();
  if (currentOptions.screenshots) await captureAndAttachShots(created);
  // Annotations are rare and are the one thing the user explicitly asked to
  // keep, so they do not ride the 400ms debounce: persist before answering, or
  // a service-worker teardown in that window silently loses a saved note.
  await persister.flush();
  return { ok: true, index: created.index };
}

async function handleStateRequest(_message, sender) {
  const session = store.getSession();
  if (sender.tab && sender.tab.id === store.getTabId() && session) {
    chrome.tabs
      .sendMessage(sender.tab.id, { type: MSG.RESTORE_PINS, annotations: session.annotations })
      .catch(() => {});
  }
  return store.toState();
}

// --- export ---

async function collectShotBlobs(session) {
  const pathsByKey = new Map();
  for (const ann of session.annotations) {
    if (ann.shots?.full || ann.shots?.element) {
      pathsByKey.set(`${STORAGE.SHOT_PREFIX}${ann.index}`, ann.shots);
    }
  }
  if (pathsByKey.size === 0) return {};
  const stored = await chrome.storage.local.get([...pathsByKey.keys()]);
  const blobs = {};
  for (const [key, paths] of pathsByKey) {
    const shot = stored[key];
    if (!shot) continue;
    if (paths.full && shot.full) blobs[paths.full] = shot.full;
    if (paths.element && shot.element) blobs[paths.element] = shot.element;
  }
  return blobs;
}

/**
 * Records which session owns which export folder, so a later session cannot
 * overwrite an earlier one's evidence while a re-export of the same session
 * still overwrites itself (PROTOCOL §4). Best-effort: if the bookkeeping read
 * or write fails, the export proceeds under the plain folder name.
 */
async function claimExportFolder(base, sessionId) {
  try {
    const stored = await chrome.storage.local.get(STORAGE.EXPORTS);
    const claims = stored[STORAGE.EXPORTS] || {};
    const folder = claimFolder(base, claims, sessionId);
    if (claims[folder] !== sessionId) {
      await chrome.storage.local.set({ [STORAGE.EXPORTS]: { ...claims, [folder]: sessionId } });
    }
    return folder;
  } catch (err) {
    console.error('[bugpin] could not claim an export folder', err);
    return base;
  }
}

async function handleExport() {
  try {
    await persister.flush();
    const session = store.getSession();
    if (!session) return { ok: false, error: 'no active session' };
    const { folder: base, files } = buildExport(session);
    const folder = await claimExportFolder(base, session.id);
    const blobs = await collectShotBlobs(session);
    const written = await writeExportFolder({ folder, files, blobs });
    // The folder path is copied by the popup (PROTOCOL §6 copyPathOnExport):
    // a service worker has no navigator.clipboard.
    return { ok: true, folder: written.folder, files: written.files };
  } catch (err) {
    console.error('[bugpin] export failed', err);
    return { ok: false, error: err.message || String(err) };
  }
}

// --- message routing ---

const HANDLERS = {
  [MSG.STATUS]: async () => store.toState(),
  [MSG.START]: handleStart,
  [MSG.STOP]: handleStop,
  [MSG.TOGGLE_ANNOTATE]: handleToggleAnnotate,
  [MSG.EXPORT]: handleExport,
  [MSG.DISCARD]: handleDiscard,
  [MSG.EVENT]: handleEvent,
  [MSG.ANNOTATION]: handleAnnotation,
  [MSG.STATE_REQUEST]: handleStateRequest,
};

function onMessage(message, sender, sendResponse) {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  readyPromise
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error('[bugpin] handler failed', message?.type, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // async response
}

/**
 * Without this the session outlives its tab: `isRecording()` stays true
 * forever, the webRequest/webNavigation listeners stay attached to a dead
 * tabId, and the badge is stuck on REC. Stop (not Discard) — whatever was
 * captured before the tab closed is still worth exporting.
 */
function onTabRemoved(tabId) {
  readyPromise
    .then(() => {
      if (!store.isRecording() || tabId !== store.getTabId()) return null;
      return handleStop();
    })
    .catch((err) => console.error('[bugpin] stop-on-tab-close failed', err));
}

function onCommand(command) {
  if (command !== 'toggle-annotate') return;
  readyPromise
    .then(() => handleToggleAnnotate({}))
    .catch((err) => console.error('[bugpin] toggle-annotate command failed', err));
}
