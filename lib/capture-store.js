/**
 * Pure session-state model — PROTOCOL.md §3. No chrome.* usage; persistence
 * is injected via `persist(serializedSession)`. Every mutation returns a NEW
 * object (never the internal reference) and every mutation attempts to
 * persist, surfacing failures through `onError` instead of throwing.
 */

import { LIMITS } from './messages.js';

/** @param {*} value */
function cloneDeep(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

/** @param {*} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check used by hydrate() to reject missing/corrupt/older shapes. */
function isValidSession(obj) {
  return (
    isPlainObject(obj) &&
    typeof obj.id === 'string' && obj.id.length > 0 &&
    typeof obj.tabId === 'number' &&
    typeof obj.startedAt === 'number' &&
    (obj.stoppedAt === null || typeof obj.stoppedAt === 'number') &&
    typeof obj.startUrl === 'string' &&
    typeof obj.annotating === 'boolean' &&
    Array.isArray(obj.events) &&
    Array.isArray(obj.annotations) &&
    typeof obj.droppedOldestEvents === 'number' &&
    isPlainObject(obj.system)
  );
}

/**
 * Per-element checks used by hydrate(). The envelope check above only proves
 * `events`/`annotations` are arrays; a stored session from an older schema (or
 * tampered chrome.storage.local) can still hold entries that break sorting
 * (`ts` missing -> NaN comparisons in export) or shot attachment (duplicate /
 * missing `index`). Bad entries are dropped rather than failing the whole
 * restore — a partial session is still worth exporting.
 */
function isValidEvent(evt) {
  return isPlainObject(evt) && typeof evt.kind === 'string' && evt.kind.length > 0 && Number.isFinite(evt.ts);
}

function isValidAnnotation(annotation) {
  return isPlainObject(annotation) && Number.isInteger(annotation.index) && annotation.index > 0;
}

function sanitizeEvents(events) {
  return events.filter(isValidEvent);
}

/** Keeps the first entry per index so `attachShots` can never hit a duplicate. */
function sanitizeAnnotations(annotations) {
  const seen = new Set();
  const kept = [];
  for (const annotation of annotations) {
    if (!isValidAnnotation(annotation) || seen.has(annotation.index)) continue;
    seen.add(annotation.index);
    kept.push(annotation);
  }
  return kept;
}

const EMPTY_STATE = Object.freeze({
  recording: false,
  annotating: false,
  tabId: null,
  eventCount: 0,
  annotationCount: 0,
  startedAt: null,
  startUrl: null,
  droppedOldestEvents: 0,
});

/**
 * @param {{ persist: (session: object|null) => Promise<void>|void,
 *           now?: () => number, randomId?: () => string|number,
 *           onError?: (err: unknown) => void, maxEvents?: number }} options
 */
export function createStore(options = {}) {
  const {
    persist,
    now = Date.now,
    randomId = () => Math.random().toString(36).slice(2, 10),
    onError = () => {},
    maxEvents: initialMaxEvents = LIMITS.MAX_EVENTS,
  } = options;

  if (typeof persist !== 'function') {
    throw new Error('createStore requires options.persist to be a function');
  }

  let session = null;
  let maxEvents = initialMaxEvents;

  function persistNow() {
    const snapshot = session ? cloneDeep(session) : null;
    Promise.resolve()
      .then(() => persist(snapshot))
      .catch((err) => onError(err));
  }

  function requireSession(callerName) {
    if (!session) throw new Error(`${callerName} requires an active session`);
  }

  function trimRingBuffer(events, droppedSoFar) {
    if (events.length <= maxEvents) {
      return { events, dropped: droppedSoFar };
    }
    const overflow = events.length - maxEvents;
    return { events: events.slice(overflow), dropped: droppedSoFar + overflow };
  }

  function startSession({ tabId, startUrl, system }) {
    const startedAt = now();
    session = {
      id: `${startedAt}-${randomId()}`,
      tabId,
      startedAt,
      stoppedAt: null,
      startUrl,
      annotating: false,
      events: [],
      annotations: [],
      droppedOldestEvents: 0,
      system,
    };
    persistNow();
    return cloneDeep(session);
  }

  function getSession() {
    return session ? cloneDeep(session) : null;
  }

  function isRecording() {
    return session !== null && session.stoppedAt === null;
  }

  /** Cheap accessor (no clone) for the bound tab — hot path for event filtering. */
  function getTabId() {
    return session ? session.tabId : null;
  }

  function appendEvent(partialEvent) {
    if (!session) return null;
    const event = {
      ...partialEvent,
      id: partialEvent.id ?? String(randomId()),
      ts: partialEvent.ts ?? now(),
    };
    const { events, dropped } = trimRingBuffer(session.events.concat([event]), session.droppedOldestEvents);
    session = { ...session, events, droppedOldestEvents: dropped };
    persistNow();
    return cloneDeep(event);
  }

  /**
   * Highest existing index + 1 rather than `length + 1`: a hydrated session
   * whose annotation list has a gap would otherwise reissue an index that is
   * already taken, and `attachShots` would then bind a screenshot to the wrong
   * note.
   */
  function nextAnnotationIndex() {
    let max = 0;
    for (const annotation of session.annotations) {
      if (Number.isInteger(annotation.index) && annotation.index > max) max = annotation.index;
    }
    return max + 1;
  }

  function addAnnotation(annotationIn) {
    requireSession('addAnnotation');
    if (session.annotations.length >= LIMITS.MAX_ANNOTATIONS) {
      throw new Error(`Cannot add annotation: limit of ${LIMITS.MAX_ANNOTATIONS} reached`);
    }
    const index = nextAnnotationIndex();
    const annotation = { ...annotationIn, index, shots: { full: null, element: null } };
    session = { ...session, annotations: session.annotations.concat([annotation]) };
    // The marker carries the CLIENT timestamp (when the user hit Save), not the
    // time the worker got round to processing the message — otherwise the two
    // RAFs + sendMessage round trip push the marker past events it should sit
    // between, and report.md's "Nearby events" misses the actual error.
    appendEvent({
      kind: 'annotation',
      ts: Number.isFinite(annotationIn.ts) ? annotationIn.ts : undefined,
      index,
      note: annotationIn.note,
      selector: annotationIn.selector,
    });
    return cloneDeep(annotation);
  }

  function attachShots(index, shotsIn) {
    requireSession('attachShots');
    const pos = session.annotations.findIndex((a) => a.index === index);
    if (pos === -1) throw new Error(`No annotation with index ${index}`);
    const existing = session.annotations[pos];
    const shots = {
      full: 'full' in shotsIn ? shotsIn.full : existing.shots.full,
      element: 'element' in shotsIn ? shotsIn.element : existing.shots.element,
    };
    const updated = { ...existing, shots };
    const annotations = session.annotations.slice();
    annotations[pos] = updated;
    session = { ...session, annotations };
    persistNow();
    return cloneDeep(updated);
  }

  function setAnnotating(annotating) {
    requireSession('setAnnotating');
    session = { ...session, annotating: Boolean(annotating) };
    persistNow();
    return cloneDeep(session);
  }

  function setMaxEvents(n) {
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('setMaxEvents requires a positive finite number');
    }
    maxEvents = Math.floor(n);
    if (session) {
      const { events, dropped } = trimRingBuffer(session.events, session.droppedOldestEvents);
      session = { ...session, events, droppedOldestEvents: dropped };
    }
    persistNow();
    return session ? cloneDeep(session) : null;
  }

  function stopSession() {
    if (!session) return null;
    session = { ...session, stoppedAt: now() };
    persistNow();
    return cloneDeep(session);
  }

  function discardSession() {
    session = null;
    persistNow();
    return null;
  }

  function toState() {
    if (!session) return { ...EMPTY_STATE };
    return {
      recording: session.stoppedAt === null,
      annotating: session.annotating,
      tabId: session.tabId,
      eventCount: session.events.length,
      annotationCount: session.annotations.length,
      startedAt: session.startedAt,
      startUrl: session.startUrl,
      droppedOldestEvents: session.droppedOldestEvents,
    };
  }

  function serialize() {
    return session ? cloneDeep(session) : null;
  }

  function hydrate(sessionObject) {
    if (!isValidSession(sessionObject)) {
      session = null;
      return null;
    }
    let restored;
    try {
      restored = cloneDeep(sessionObject);
    } catch (err) {
      session = null;
      onError(err);
      return null;
    }
    session = {
      ...restored,
      events: sanitizeEvents(restored.events),
      annotations: sanitizeAnnotations(restored.annotations),
    };
    return cloneDeep(session);
  }

  return {
    startSession,
    getSession,
    isRecording,
    getTabId,
    appendEvent,
    addAnnotation,
    attachShots,
    setAnnotating,
    setMaxEvents,
    stopSession,
    discardSession,
    toState,
    serialize,
    hydrate,
  };
}
