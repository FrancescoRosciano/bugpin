import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/capture-store.js';
import { LIMITS } from '../lib/messages.js';

function makeClock(start = 1000) {
  let t = start;
  return () => t++;
}

function makeIdGen(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${n++}`;
}

function makeRecordingPersist() {
  const calls = [];
  const persist = async (session) => {
    calls.push(session);
  };
  return { persist, calls };
}

function makeSystemInfo() {
  return {
    capturedAt: 'x', startUrl: 'https://example.com', userAgent: 'ua',
    platform: 'p', language: 'en', viewport: { width: 1, height: 1 },
    screen: { width: 1, height: 1 }, devicePixelRatio: 1,
    extensionVersion: '0.1.0', chromeVersion: '120', timezone: 'UTC',
  };
}

function makeAnnotationIn(overrides = {}) {
  return {
    note: 'broken button',
    selector: '#foo', xpath: '//*[@id="foo"]', label: 'button#foo',
    tagName: 'BUTTON', attrs: {}, text: 'Submit',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    devicePixelRatio: 1, url: 'https://example.com', ts: 1,
    ...overrides,
  };
}

test('startSession creates a fresh session and persists it', async () => {
  const { persist, calls } = makeRecordingPersist();
  const store = createStore({ persist, now: makeClock(), randomId: makeIdGen() });
  const session = store.startSession({ tabId: 7, startUrl: 'https://a.test', system: makeSystemInfo() });

  assert.equal(session.tabId, 7);
  assert.equal(session.stoppedAt, null);
  assert.equal(session.events.length, 0);
  assert.equal(store.isRecording(), true);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabId, 7);
});

test('appendEvent stamps id/ts when absent and returns null with no session', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  assert.equal(store.appendEvent({ kind: 'console', level: 'log', text: 'hi', url: 'x' }), null);

  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  const event = store.appendEvent({ kind: 'console', level: 'log', text: 'hi', url: 'x' });
  assert.equal(typeof event.id, 'string');
  assert.equal(typeof event.ts, 'number');

  const explicit = store.appendEvent({ id: 'e-fixed', ts: 42, kind: 'console', level: 'warn', text: 'w', url: 'x' });
  assert.equal(explicit.id, 'e-fixed');
  assert.equal(explicit.ts, 42);
});

test('ring buffer evicts oldest events and accounts drops', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen(), maxEvents: 3 });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  for (let i = 0; i < 5; i++) {
    store.appendEvent({ kind: 'console', level: 'log', text: `${i}`, url: 'x' });
  }
  const session = store.getSession();
  assert.equal(session.events.length, 3);
  assert.deepEqual(session.events.map((e) => e.text), ['2', '3', '4']);
  assert.equal(session.droppedOldestEvents, 2);
});

test('setMaxEvents trims immediately and accumulates dropped count', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  for (let i = 0; i < 5; i++) {
    store.appendEvent({ kind: 'console', level: 'log', text: `${i}`, url: 'x' });
  }
  const session = store.setMaxEvents(2);
  assert.equal(session.events.length, 2);
  assert.deepEqual(session.events.map((e) => e.text), ['3', '4']);
  assert.equal(session.droppedOldestEvents, 3);

  assert.throws(() => store.setMaxEvents(0), /positive/);
  assert.throws(() => store.setMaxEvents(-1), /positive/);
});

test('addAnnotation assigns 1-based index, initial shots, and a marker event', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });

  const first = store.addAnnotation(makeAnnotationIn({ note: 'first' }));
  const second = store.addAnnotation(makeAnnotationIn({ note: 'second' }));

  assert.equal(first.index, 1);
  assert.equal(second.index, 2);
  assert.deepEqual(first.shots, { full: null, element: null });

  const session = store.getSession();
  const markers = session.events.filter((e) => e.kind === 'annotation');
  assert.equal(markers.length, 2);
  assert.equal(markers[0].index, 1);
  assert.equal(markers[0].note, 'first');
  assert.equal(markers[0].selector, '#foo');
});

test('addAnnotation refuses past LIMITS.MAX_ANNOTATIONS', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen(), maxEvents: 100000 });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  for (let i = 0; i < LIMITS.MAX_ANNOTATIONS; i++) {
    store.addAnnotation(makeAnnotationIn({ note: `n${i}` }));
  }
  assert.throws(() => store.addAnnotation(makeAnnotationIn({ note: 'overflow' })), /MAX_ANNOTATIONS|limit/);
});

test('addAnnotation throws with no active session', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  assert.throws(() => store.addAnnotation(makeAnnotationIn()), /active session/);
});

test('attachShots sets export-relative paths on the matching annotation', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  store.addAnnotation(makeAnnotationIn());

  const updated = store.attachShots(1, { full: 'shots/01-full.jpg', element: 'shots/01-element.jpg' });
  assert.equal(updated.shots.full, 'shots/01-full.jpg');
  assert.equal(updated.shots.element, 'shots/01-element.jpg');

  assert.throws(() => store.attachShots(99, { full: 'x', element: 'y' }), /No annotation/);
});

test('persist failures are caught and surfaced via onError, never thrown', async () => {
  const errors = [];
  const persist = async () => { throw new Error('disk full'); };
  const store = createStore({ persist, now: makeClock(), randomId: makeIdGen(), onError: (e) => errors.push(e) });

  assert.doesNotThrow(() => {
    store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'disk full');
});

test('synchronous persist throw is also caught via onError', async () => {
  const errors = [];
  const persist = () => { throw new Error('sync boom'); };
  const store = createStore({ persist, now: makeClock(), randomId: makeIdGen(), onError: (e) => errors.push(e) });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'sync boom');
});

test('serialize/hydrate round-trip and toState projection', () => {
  const storeA = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  storeA.startSession({ tabId: 5, startUrl: 'https://a.test', system: makeSystemInfo() });
  storeA.addAnnotation(makeAnnotationIn());
  const dump = storeA.serialize();

  const storeB = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  const restored = storeB.hydrate(dump);
  assert.equal(restored.tabId, 5);
  assert.equal(storeB.isRecording(), true);

  const state = storeB.toState();
  assert.equal(state.recording, true);
  assert.equal(state.tabId, 5);
  assert.equal(state.annotationCount, 1);
  assert.equal(state.eventCount, 1);
});

test('hydrate tolerates missing/corrupt/older-shaped input without throwing', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });

  for (const bad of [null, undefined, {}, { id: 'x' }, 'not-an-object', 42, { id: 'x', tabId: 1 }]) {
    assert.doesNotThrow(() => {
      const result = store.hydrate(bad);
      assert.equal(result, null);
    });
    assert.equal(store.getSession(), null);
    assert.equal(store.isRecording(), false);
  }
});

// --- regressions -----------------------------------------------------------

test('addAnnotation stamps the marker with the CLIENT ts, not the processing time', () => {
  // The overlay builds the payload at Save; two RAFs + the sendMessage round
  // trip land the message at the worker measurably later. Using now() for the
  // marker pushed it past events it should sit between, so report.md's
  // "Nearby events" could miss the very error the note points at.
  const store = createStore({ persist: async () => {}, now: makeClock(9000), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  store.appendEvent({ ts: 500, kind: 'console', level: 'error', text: 'boom', url: 'x' });

  store.addAnnotation(makeAnnotationIn({ ts: 501 }));

  const marker = store.getSession().events.find((e) => e.kind === 'annotation');
  assert.equal(marker.ts, 501);
});

test('addAnnotation falls back to now() when the payload carries no usable ts', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(9000), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });

  store.addAnnotation(makeAnnotationIn({ ts: undefined }));
  store.addAnnotation(makeAnnotationIn({ ts: Number.NaN }));

  const markers = store.getSession().events.filter((e) => e.kind === 'annotation');
  assert.equal(markers.length, 2);
  for (const marker of markers) assert.equal(Number.isFinite(marker.ts), true);
});

test('addAnnotation derives the next index from the highest existing one, not the length', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  const restored = {
    id: 'sess-1', tabId: 1, startedAt: 1, stoppedAt: null,
    startUrl: 'https://a.test', annotating: false,
    events: [],
    // A gap: index 2 is gone (older schema / partial write). `length + 1`
    // would reissue index 2 and attachShots would bind the shot to the wrong
    // note; the index must keep climbing.
    annotations: [
      { ...makeAnnotationIn(), index: 1, shots: { full: null, element: null } },
      { ...makeAnnotationIn(), index: 3, shots: { full: null, element: null } },
    ],
    droppedOldestEvents: 0, system: makeSystemInfo(),
  };
  store.hydrate(restored);

  assert.equal(store.addAnnotation(makeAnnotationIn()).index, 4);
});

test('hydrate drops events with a non-numeric ts instead of poisoning the sort', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  const restored = {
    id: 'sess-1', tabId: 1, startedAt: 1, stoppedAt: null,
    startUrl: 'https://a.test', annotating: false,
    events: [
      { id: 'ok', ts: 10, kind: 'console', level: 'log', text: 'fine', url: 'x' },
      { id: 'no-ts', kind: 'console', level: 'log', text: 'missing ts', url: 'x' },
      { id: 'nan-ts', ts: Number.NaN, kind: 'console', level: 'log', text: 'nan', url: 'x' },
      { id: 'no-kind', ts: 20, text: 'kindless', url: 'x' },
      'not-an-object',
    ],
    annotations: [],
    droppedOldestEvents: 0, system: makeSystemInfo(),
  };

  const session = store.hydrate(restored);
  assert.deepEqual(session.events.map((e) => e.id), ['ok']);
  assert.equal(store.toState().eventCount, 1);
});

test('hydrate drops duplicate/invalid annotation indices so attachShots cannot mis-bind', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  const restored = {
    id: 'sess-1', tabId: 1, startedAt: 1, stoppedAt: null,
    startUrl: 'https://a.test', annotating: false,
    events: [],
    annotations: [
      { ...makeAnnotationIn({ note: 'keep' }), index: 1, shots: { full: null, element: null } },
      { ...makeAnnotationIn({ note: 'duplicate' }), index: 1, shots: { full: null, element: null } },
      { ...makeAnnotationIn({ note: 'no index' }), shots: { full: null, element: null } },
      { ...makeAnnotationIn({ note: 'zero' }), index: 0, shots: { full: null, element: null } },
      { ...makeAnnotationIn({ note: 'fractional' }), index: 1.5, shots: { full: null, element: null } },
    ],
    droppedOldestEvents: 0, system: makeSystemInfo(),
  };

  const session = store.hydrate(restored);
  assert.deepEqual(session.annotations.map((a) => a.note), ['keep']);

  // The surviving annotation is the one a screenshot binds to.
  const updated = store.attachShots(1, { full: 'shots/01-full.jpg', element: null });
  assert.equal(updated.note, 'keep');
});

test('hydrate keeps a well-formed session completely intact', () => {
  const storeA = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  storeA.startSession({ tabId: 5, startUrl: 'https://a.test', system: makeSystemInfo() });
  storeA.appendEvent({ kind: 'console', level: 'log', text: 'hi', url: 'x' });
  storeA.addAnnotation(makeAnnotationIn());
  const dump = storeA.serialize();

  const storeB = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  assert.deepEqual(storeB.hydrate(dump), dump);
});

test('toState with no session returns the empty SessionState shape', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  assert.deepEqual(store.toState(), {
    recording: false, annotating: false, tabId: null, eventCount: 0,
    annotationCount: 0, startedAt: null, startUrl: null, droppedOldestEvents: 0,
  });
});

test('setAnnotating and stopSession and discardSession transition state', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });

  const annotating = store.setAnnotating(true);
  assert.equal(annotating.annotating, true);

  const stopped = store.stopSession();
  assert.notEqual(stopped.stoppedAt, null);
  assert.equal(store.isRecording(), false);

  const discarded = store.discardSession();
  assert.equal(discarded, null);
  assert.equal(store.getSession(), null);
});

test('discardSession and stopSession are no-ops (return null) with no active session', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  assert.equal(store.stopSession(), null);
  assert.equal(store.discardSession(), null);
});

test('returned objects are copies: mutating them never corrupts the store', () => {
  const store = createStore({ persist: async () => {}, now: makeClock(), randomId: makeIdGen() });
  const started = store.startSession({ tabId: 1, startUrl: 'https://a.test', system: makeSystemInfo() });
  started.tabId = 999;
  started.events.push({ id: 'intruder', ts: 0, kind: 'console', level: 'log', text: 'x', url: 'x' });

  const again = store.getSession();
  assert.equal(again.tabId, 1);
  assert.equal(again.events.length, 0);
  assert.notEqual(again, started);
  assert.notEqual(again.events, started.events);

  const annotation = store.addAnnotation(makeAnnotationIn());
  annotation.shots.full = 'hacked.jpg';
  const roundTrip = store.serialize();
  assert.equal(roundTrip.annotations[0].shots.full, null);

  const state = store.toState();
  const rawSession = store.getSession();
  assert.notEqual(state, rawSession);
});

test('createStore throws without a persist function', () => {
  assert.throws(() => createStore({}), /persist/);
});
