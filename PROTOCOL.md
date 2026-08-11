# BugPin — internal contract (authoritative)

Every module in this extension MUST conform to this file. Do not invent new
message types, storage keys, field names, or file names. If something seems
missing, implement it under the closest existing name rather than adding a new
concept.

## 1. Components

| File | World / context | Responsibility |
| --- | --- | --- |
| `content-console-inject.js` | content script, MAIN world, `document_start` | Patches `console.*`, `window.onerror`, `unhandledrejection`. Emits to the bridge via `window.postMessage`. Never touches `chrome.*` (it cannot see it). |
| `content-bridge.js` | content script, ISOLATED world, `document_start` | Receives MAIN-world messages, captures E2E steps (click / input / change / submit / key), forwards everything to the service worker. Owns nothing visual. |
| `content-annotate.js` | content script, ISOLATED world, `document_idle` | The annotation overlay: hover highlight, selector tooltip, inline note box, numbered pins. All UI lives in a closed Shadow DOM root. |
| `background.js` | MV3 service worker (`type: module`) | Session lifecycle, network capture via `webRequest`, navigation capture via `webNavigation`, screenshot capture + crop, message router, export trigger. |
| `lib/messages.js` | shared ES module | Frozen constants for every message type and storage key. |
| `lib/selector.js` | shared ES module (also inlined into content scripts via import) | Stable selector + XPath + human label generation for a DOM element. |
| `lib/capture-store.js` | shared ES module | Pure session-state model: append event, cap ring buffer, add annotation, serialize. No `chrome.*` calls except the thin persist adapter it is handed. |
| `lib/export.js` | shared ES module | Turns a serialized session into the export file set (pure string generation) + the download plan. |
| `lib/redact.js` | shared ES module | Secret / PII scrubbing used by every producer. |
| `popup.html` / `popup.js` | extension popup | Start / stop, annotate toggle, note count, export, options link. |
| `options.html` / `options.js` | options page | Preferences (see §6). |

Content scripts are declared as classic scripts in the manifest, so shared `lib/`
modules that content scripts need are imported with a dynamic
`import(chrome.runtime.getURL('lib/x.js'))` and the file listed in
`web_accessible_resources`. Service worker uses static `import`.

## 2. Message types (`lib/messages.js`)

```js
export const MSG = Object.freeze({
  // MAIN world -> ISOLATED bridge (window.postMessage; always check e.source === window)
  MAIN_TO_BRIDGE: 'bugpin:main->bridge',

  // content -> service worker (chrome.runtime.sendMessage)
  EVENT:        'bugpin:event',        // { event: Event }            -> { ok }
  ANNOTATION:   'bugpin:annotation',   // { annotation: AnnotationIn } -> { ok, index }
  STATE_REQUEST:'bugpin:state?',       // {}                          -> SessionState

  // service worker -> content (chrome.tabs.sendMessage)
  SET_MODE:     'bugpin:set-mode',     // { annotating: boolean }
  RESTORE_PINS: 'bugpin:restore-pins', // { annotations: AnnotationOut[] }

  // popup/options -> service worker
  START:        'bugpin:start',        // {}            -> SessionState  (binds the ACTIVE tab)
  STOP:         'bugpin:stop',         // {}            -> SessionState
  TOGGLE_ANNOTATE:'bugpin:toggle-annotate', // { on?: boolean } -> SessionState
  EXPORT:       'bugpin:export',       // {}            -> { ok, folder, files, error? }
  STATUS:       'bugpin:status',       // {}            -> SessionState
  DISCARD:      'bugpin:discard',      // {}            -> SessionState
});

export const STORAGE = Object.freeze({
  SESSION: 'bugpin.session',      // Session (without screenshot payloads)
  SHOT_PREFIX: 'bugpin.shot.',    // + annotationIndex -> { full: dataUrl, element: dataUrl }
  OPTIONS: 'bugpin.options',      // Options
  EXPORTS: 'bugpin.exports',      // exportFolderName -> session id that owns it
});

export const LIMITS = Object.freeze({
  MAX_EVENTS: 5000,               // ring buffer; oldest dropped first
  MAX_ANNOTATIONS: 50,
  MAX_SHOTS: 25,                  // screenshots stop being taken past this
  MAX_STRING: 4000,               // any single captured string is truncated to this
  SHOT_QUALITY: 0.7,              // JPEG quality for both full and element shots
  ELEMENT_SHOT_PAD: 8,            // px padding around the cropped element
});
```

## 3. Data shapes

```ts
type Session = {
  id: string;                 // `${startedAt}-${rand}`
  tabId: number;
  startedAt: number;          // epoch ms
  stoppedAt: number | null;
  startUrl: string;
  annotating: boolean;
  events: Event[];            // capped at LIMITS.MAX_EVENTS
  annotations: AnnotationOut[];
  droppedOldestEvents: number;
  system: SystemInfo;         // filled at start
};

type Event =
  | { id: string; ts: number; kind: 'console'; level: 'log'|'info'|'warn'|'error'|'debug';
      text: string; stack?: string; url: string }
  | { id: string; ts: number; kind: 'network'; method: string; url: string;
      status: number | null; statusText?: string; resourceType: string;
      durationMs: number | null; failed: boolean; error?: string; fromCache?: boolean }
  | { id: string; ts: number; kind: 'step'; action: 'click'|'input'|'change'|'submit'|'key';
      selector: string; xpath: string; label: string; value?: string; url: string }
  | { id: string; ts: number; kind: 'nav'; from: string; to: string;
      transition: string }
  | { id: string; ts: number; kind: 'annotation'; index: number; note: string;
      selector: string };     // marker so annotations appear in the merged timeline
                              // ts MIRRORS AnnotationIn.ts (the client clock at
                              // Save), never the time the worker processed it —
                              // otherwise the marker sorts past the very events
                              // report.md's "Nearby events" is meant to surface.

type AnnotationIn = {          // content -> service worker
  note: string;
  selector: string; xpath: string; label: string;
  tagName: string; attrs: Record<string,string>;   // id, class, name, type, data-testid, aria-label, href
  text: string;                                    // trimmed innerText, <= 200 chars
  rect: { x: number; y: number; width: number; height: number };  // viewport coords, CSS px
  devicePixelRatio: number;
  url: string; ts: number;
};

type AnnotationOut = AnnotationIn & {
  index: number;               // 1-based, stable, used for pin badge + file names
  shots: { full: string | null; element: string | null };  // export-relative paths or null
};

type SystemInfo = {
  capturedAt: string; startUrl: string; userAgent: string; platform: string;
  language: string; viewport: { width: number; height: number };
  screen: { width: number; height: number }; devicePixelRatio: number;
  extensionVersion: string; chromeVersion: string; timezone: string;
};

type SessionState = {          // what every popup-facing message resolves to
  recording: boolean; annotating: boolean; tabId: number | null;
  eventCount: number; annotationCount: number; startedAt: number | null;
  startUrl: string | null; droppedOldestEvents: number;
};
```

## 4. Export layout

Folder name: `MM-DD-HH.MM-<label>` under the browser Downloads dir.
`label` = slug of the FIRST annotation's note, else the last console error, else
`session`. Slug: lowercase, non-alphanumerics → `-`, collapsed, trimmed, max 40
chars. Never empty.

```
MM-DD-HH.MM-delete-this/
  report.md          full merged report: annotations inline w/ images, then timeline
  annotations.txt    one block per note: index, note, selector, xpath, label, url, ts
  console.txt        one line per console/error event
  network.txt        one line per request; failures marked `FAIL`
  e2e-helper.txt     numbered human-readable repro steps (clicks/typing/navigation)
  e2e.spec.ts        Playwright test skeleton generated from the same steps
  system-info.txt    SystemInfo, plus event counts and droppedOldestEvents
  session.json       the raw serialized Session (source of truth)
  shots/01-full.jpg  full visible-tab screenshot at annotation time
  shots/01-element.jpg  cropped element (rect + LIMITS.ELEMENT_SHOT_PAD)
```

`report.md` references shots as `shots/01-element.jpg` so it renders in any
Markdown viewer sitting in that folder.

The folder name is derived from the session, not from the export time, so
re-exporting the same session targets the same folder. Files are written with
`conflictAction: 'overwrite'` — per-file uniquifying would rename `report.md`
to `report (1).md` while a newly added `shots/02-*.jpg` kept its name, leaving
the report's image links dangling and stale content under the expected name.

Because the name carries only minutes, two *different* sessions in the same
minute whose first note reads the same would collide — and overwrite semantics
would then destroy the first session's evidence. `STORAGE.EXPORTS` records which
session owns each folder; a different session takes `<folder>-2`, `-3`, and so
on, while the owning session keeps overwriting its own.

## 5. Behaviour rules

- Nothing is captured until **Start session**. Capture is bound to exactly one
  `tabId`; events from any other tab are dropped.
- Session survives service-worker teardown: every mutation persists to
  `chrome.storage.local` (debounced ≤ 1s, and always flushed before export).
- Annotate mode: toggled from the popup or `Cmd/Ctrl+Shift+E`. It can be turned
  on without a session running — doing so starts a session implicitly.
- Annotate mode UI is a closed Shadow DOM host appended to
  `document.documentElement`, `z-index: 2147483647`, `pointer-events` managed so
  the overlay never blocks the page when annotate mode is off. The host element
  and everything in it must be excluded from selector generation and from E2E
  step capture (mark with `data-bugpin-ui`).
- In annotate mode the content script swallows the hover/click it uses
  (`capture: true`, `preventDefault`, `stopPropagation`) so annotating never
  triggers page behaviour.
- `Esc` exits annotate mode. `Enter` saves the note; `Shift+Enter` newline.
- Screenshots: the service worker calls `chrome.tabs.captureVisibleTab` right
  after the note is saved and the overlay input is hidden (the pin badge stays).
  Cropping uses `createImageBitmap` + `OffscreenCanvas` in the service worker —
  no offscreen document. Rect is scaled by `devicePixelRatio`.
- Redaction (`lib/redact.js`) is applied by the producer, before storage:
  password-typed inputs never record a value; `Authorization` / `Cookie` /
  `Set-Cookie` are never recorded (BugPin reads no request or response headers
  at all); strings matching common secret shapes (`sk-…`, `Bearer …`,
  `api[_-]?key=…`, `token=…`, long JWT) are replaced with `«redacted»`. Query
  strings keep keys, redact values of `token|key|secret|password|auth|session`.
- The generic "long opaque blob" rule is deliberately narrow: only a standalone
  run of ≥ 32 base64url characters that mixes lower-case, upper-case AND digits
  is redacted. Single-case runs (hex ids, git SHAs, slugs) and anything adjacent
  to `/` (file paths, URL path segments) are left intact — over-redaction
  destroys the diagnostics an export exists to carry, and a redacted string
  carries no marker distinguishing a real secret from a false positive.
- Every producer redacts EVERY string it emits: console `text`/`stack` and step
  `value`/`label` (bridge), annotation `note`/`text`/`attrs` (overlay), every
  `url` field on every event and annotation (query-string rule), and
  `Session.startUrl`. `selector` / `xpath` are truncated but never redacted —
  they must stay valid for pin restore and the generated Playwright spec.
- Every captured string is truncated to `LIMITS.MAX_STRING` with a `… (+N chars)`
  suffix.
- The plain-text export files strip C0/C1 control characters (everything except
  TAB and LF) from page-controlled strings, so a console message cannot smuggle
  terminal escape sequences into `console.txt` et al.

## 6. Options (`STORAGE.OPTIONS`)

```ts
type Options = {
  screenshots: boolean;        // default true
  fullPageShot: boolean;       // default true  (visible-tab shot alongside the crop)
  redact: boolean;             // default true
  maxEvents: number;           // default LIMITS.MAX_EVENTS
  copyPathOnExport: boolean;   // default true — copy the export folder path
};
```

## 7. Testing

Pure modules (`lib/selector.js`, `lib/capture-store.js`, `lib/export.js`,
`lib/redact.js`) are tested with `node --test test/*.test.mjs`. They must not
import `chrome.*` at module top level; anything browser-specific is passed in.
DOM-dependent code in `lib/selector.js` accepts a `document`-like object so tests
can drive it with a minimal fake. Target: every exported function has a test,
including the failure/edge paths named in this document.
