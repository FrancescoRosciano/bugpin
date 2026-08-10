# BugPin — verification record

Final fixer pass over the three review reports (protocol conformance, MV3
lifecycle, security/privacy). Every finding was re-checked against the actual
code before anything was changed; rejected findings are listed with reasons.

`PROTOCOL.md` stayed authoritative. Three contract clarifications were made in
it (flagged **[PROTOCOL CHANGE]** below) and propagated to every affected file.

---

## 1. What was run, and its status

| Command | Status |
| --- | --- |
| `cd /Users/fra/Desktop/codes/bugpin && node --test test/*.test.mjs` | **PASS — `ℹ fail 0`, 126/126 tests** (was 110; 16 added, 2 rewritten) |
| `node --check` on the 3 classic content scripts | PASS |
| `node --input-type=module --check` on `background.js`, `popup.js`, `options.js`, `lib/*.js` (11 modules) | PASS |
| `JSON.parse` on `manifest.json`, `package.json` | PASS |
| Service-worker simulation (`scratchpad/e2e.mjs`, `chrome` stub, real handlers) | **PASS — 26/26 checks** |
| Negative control: simulation re-run with the persister fix reverted | **Crashes with an unhandled `QUOTA_BYTES` rejection** — confirms the regression check is real, not vacuous |

Literal final line of the test output:

```
ℹ duration_ms 95.502875
```

with `ℹ tests 126 / ℹ pass 126 / ℹ fail 0` immediately above it.

### What the SW simulation covers

Start binds the active tab and redacts `startUrl` → events from an unbound tab
are dropped → annotate toggle → annotation returns `{ok:true,index:1}`, appends
**exactly one** marker carrying the **client** `ts`, persists immediately, and
stores the shot blob → export writes the PROTOCOL §4 set with
`conflictAction: 'overwrite'` and `report.md` links only shots that were
actually written → re-export hits the identical folder and identical path set →
a failed `storage.set` no longer breaks STOP/STATUS/DISCARD → START clears the
replaced session's orphaned shot blobs → a backgrounded tab yields no
screenshot instead of the wrong one → closing the bound tab stops (not
discards) the session → events after STOP are refused.

---

## 2. Findings CONFIRMED and fixed

Highest severity first.

### C1 — Redaction wired for only 2 of 5 producers *(protocol #1, security #1)* — HIGH
**Confirmed.** `content-annotate.js` never imported `lib/redact.js` at all, and
`content-bridge.js` stored `url` raw on both console and step events. A page at
`/reset-password?token=…` leaked the token into `report.md`, `annotations.txt`
and `session.json` — while the *same* URL was correctly redacted when it arrived
as a network/nav event.

**Fixed:**
- `content-annotate.js` now imports `redactString` / `redactUrl` / `truncate`,
  reads `Options.redact` from `STORAGE.OPTIONS` and keeps it live via
  `storage.onChanged`, and scrubs `note`, `text`, `label`, every `attrs` value
  (`href`/`src` through the URL rule, the rest through the free-text rule) and
  `url`.
- `content-bridge.js` gained `scrubUrl()`, applied to the console event `url`
  and the step event `url`; step `label` now goes through `scrub()`.
- `selector` / `xpath` are truncated but deliberately **not** redacted — they
  must stay valid for pin restore and the generated Playwright spec.
  **[PROTOCOL CHANGE]** §5 now states this explicitly and enumerates which
  producer must redact what.

### C2 — Over-broad `BLOB_RE` shredded diagnostics *(protocol #6)* — HIGH (report said MEDIUM)
**Confirmed, and more severe than reported.** `/[A-Za-z0-9+/_=-]{32,}/g` includes
`/`, so it did not just eat a hex order id — it ate **file paths in stack
traces**: `/Users/fra/Desktop/codes/bugpin/lib` is 35 chars of that alphabet and
became `«redacted»`. Nothing in PROTOCOL §5 asked for a generic blob rule.

**Fixed:** narrowed to a standalone run of ≥ 32 base64url chars that mixes
lower-case **and** upper-case **and** digits, with `/`-excluding boundaries.
Real base64/API-key secrets still match; hex ids, git SHAs, slugs and paths do
not. **[PROTOCOL CHANGE]** §5 now documents the rule and why it is narrow.

Two existing tests asserted the old behaviour (`'A'.repeat(32)` → redacted).
They asserted behaviour PROTOCOL never specified and that actively destroyed
diagnostics, so they were **rewritten**, not deleted — replaced by tests for the
documented rule plus four new false-positive tests (hex id, git SHA, all-caps
run, stack-trace path, long lowercase URL path).

### C3 — Poisoned `inFlight` promise broke Stop/Discard/Export forever *(protocol #3, security #2)* — HIGH
**Confirmed, and worse in practice than described.** `inFlight` held the raw
`chrome.storage.local` promise; on rejection it stayed a rejected promise with
no handler, so (a) every later `flush()` threw, and (b) it was an unhandled
rejection. Reverting the fix in the simulation crashes the process outright.

**Fixed:** `writeNow` now parks a promise that absorbs its own rejection and
records `lastError`; `flush()` never rejects and resolves to the last error, so
`STOP`/`DISCARD` always resolve to a `SessionState` per PROTOCOL §2.

### C4 — Orphaned screenshot blobs accumulated until the quota blew *(protocol #3, security #2)* — HIGH
**Confirmed.** Only `handleDiscard` called `clearShotKeys`. Start-without-Discard
cycles left `bugpin.shot.N` base64 JPEGs in `chrome.storage.local` forever.

**Fixed:** `handleStart` clears the shot keys of the session it is about to
replace (best-effort, wrapped so it can never break Start), and
`"unlimitedStorage"` was added to the manifest — 25 shots of a large viewport
can legitimately exceed the default 10 MB quota. `unlimitedStorage` shows no
extra user-facing permission warning and stores nothing off-machine; README
documents it.

### C5 — Re-export corrupted the bundle via per-file `uniquify` *(protocol #2)* — HIGH
**Confirmed.** `folderName` is deterministic from `session.startedAt`, so a
second export targets the same folder, and Chrome applies `uniquify`
**per file**: `report.md` → `report (1).md` while a new `shots/02-*.jpg` kept its
name, leaving the un-suffixed `report.md` holding stale content and the fresh
report's `![element](shots/01-element.jpg)` links dangling.

**Fixed:** `conflictAction: 'overwrite'`. This keeps the PROTOCOL §4 folder name
exactly as specified and makes `writeExportFolder`'s returned paths truthful.
**[PROTOCOL CHANGE]** §4 now states the overwrite semantics and why.

### C6 — `captureVisibleTab` could screenshot the wrong tab *(lifecycle #2)* — HIGH
**Confirmed.** `captureVisibleTab(windowId)` captures whatever is *active* in
that window. The window id was resolved *before* up to 1100 ms of throttling
plus any queued captures, so switching tabs mid-save embedded an unrelated page
in the export as evidence.

**Fixed:** `lib/shots.js` resolves the tab and asserts `tab.active`
**immediately before each capture attempt** (including the rate-limit retry). A
backgrounded bound tab now yields `{full:null, element:null}` — the annotation
still saves, it just carries no shot. Verified in the simulation.

### C7 — Session outlived its tab; no `tabs.onRemoved` *(lifecycle #4)* — MEDIUM
**Confirmed.** Closing the tab without Stop/Discard left `isRecording()` true
forever, webRequest/webNavigation listeners bound to a dead tabId, and the badge
stuck on REC.

**Fixed:** `chrome.tabs.onRemoved` registered top-level alongside the other
listeners; it calls `handleStop()` (not discard — captured data is still worth
exporting) only when the removed tab is the bound one.

### C8 — Content-script `onMessage` registered after an `await` *(lifecycle #3)* — MEDIUM
**Confirmed.** `content-annotate.js` awaited three dynamic imports before
registering its listener. A `SET_MODE` push landing in that gap hit no listener;
`setModeOnTab` swallows the error, so the store believed annotate mode was on
with no overlay on screen and nothing to re-trigger a catch-up.

**Fixed:** the listener is now registered **synchronously**, before the `await`,
against mirrored `lib/messages.js` literals (same pattern `content-bridge.js`
already used). Messages arriving early are buffered (cap 50) and replayed once
the modules resolve; the `STATE_REQUEST` catch-up still runs afterwards and
wins.

### C9 — `hydrate()` validated only the envelope *(protocol #4)* — MEDIUM-HIGH
**Confirmed.** A stored session could carry events without a numeric `ts`
(→ `NaN` comparisons in `sortedEvents`, "Invalid Date" in the report) or
annotations with missing/duplicate `index` (→ `attachShots` binding a shot to
the wrong note, and `length + 1` reissuing a live index).

**Fixed, three ways:**
- `hydrate()` drops events lacking a string `kind` or finite `ts`, and drops
  annotations with a non-positive-integer or duplicate `index` (first wins).
- `addAnnotation` derives the next index from the **highest existing index**,
  not `annotations.length`, so a gap can never cause a collision.
- `lib/export.js` treats a non-finite `ts` as `0` for sorting and renders
  `--:--:--.---` / `unknown` instead of `Invalid Date`/`NaN`.

### C10 — Annotation marker timestamp was stamped worker-side *(protocol #5)* — MEDIUM
**Confirmed.** `addAnnotation` called `appendEvent` without `ts`, so the marker
got `now()` at message-processing time — after two RAFs and the sendMessage
round trip. On a busy page that pushes intervening events out of the 3-event
context window, so `report.md`'s "Nearby events" can miss the very error the
note points at.

**Fixed:** the marker now carries `annotationIn.ts` (client clock at Save) when
finite, falling back to `now()` otherwise. **[PROTOCOL CHANGE]** §3 documents it
on the `annotation` Event shape.

### C11 — Debounced persistence could lose a saved annotation *(lifecycle #1)* — severity reduced
**Partially confirmed.** The mechanism is real (a bare `setTimeout` does not keep
an MV3 worker alive), but the reviewer's CRITICAL rating overstates it: Chrome's
idle timer keeps the worker alive ~30 s after the last event, so the 400 ms
window only loses data on a crash/eviction, not routine teardown.

**Fixed where it matters:** `handleAnnotation` now `await persister.flush()`
before responding. Annotations are rare, high-value and explicitly user-saved,
so they no longer ride the debounce. Console/network/step events keep the
400 ms coalescing — making those synchronous would mean a storage write per
console line, which PROTOCOL §5 explicitly does not ask for.

### C12 — Control characters reached the plain-text exports *(security #6)* — LOW
**Confirmed.** `esc` defaulted to identity, so page-controlled console text
carried raw ANSI/OSC escapes into `console.txt` et al., which get read with
`cat`/`less`.

**Fixed:** `lib/export.js` strips C0/C1 controls (keeping only TAB and LF; CR is
stripped so a line cannot overwrite the previous one) from every rendered
string, including inside `escapeMd` and `escapeJsString`. `session.json` was
already safe — `JSON.stringify` escapes controls. **[PROTOCOL CHANGE]** §5
records this.

### C13 — MAIN-world patch relied on un-snapshotted builtins *(lifecycle #5)* — LOW
**Confirmed.** `Array.prototype.slice`, `WeakSet` and `WeakMap` were reached for
at call time, long after a page could have replaced them; capture would then
throw and go silently dark.

**Fixed:** all three snapshotted into `NATIVE` at `document_start` alongside the
existing entries.

### C14 — No terminal "context invalidated" message in the annotate UI *(lifecycle #6)* — LOW
**Confirmed.** After an extension reload the note box said "Try again", which can
never work.

**Fixed:** `saveErrorMessage()` detects the same two substrings
`content-bridge.js` already special-cases and shows "BugPin was updated — reload
the page to keep annotating."

### C15 — README overstated the header-stripping guarantee *(security #7)* — LOW
**Confirmed.** `lib/network-capture.js` reads no headers at all, so the
"`Authorization`/`Cookie`/`Set-Cookie` headers are stripped" wording described a
mechanism that does not exist.

**Fixed:** README now says headers are never captured in the first place, notes
that query-string redaction applies to every URL BugPin records, and states that
blob matching is deliberately conservative. PROTOCOL §5 wording aligned.

---

## 3. Findings REJECTED (with reasons)

### R1 — "postMessage forgery" *(security #3)* — accepted limitation, not fixable
The claim is technically accurate: `content-bridge.js` checks
`evt.source === window` but cannot prove provenance. It is **not fixable in
principle**. The MAIN-world script shares the page's JS realm, and any nonce
scheme is defeated the moment a genuine event is posted — the page can attach
its own `message` listener and read the nonce off the first real console event.
Blast radius is limited (the `kind` is hard-coded downstream, renderers escape,
and the payoff is corrupting your own bug report). Documented as accepted rather
than papered over with a mitigation that does not mitigate.

### R2 — "Overlay is detectable and spoofable" *(security #4)* — contract-mandated
PROTOCOL §5 *requires* the host to be marked with `data-bugpin-ui` and to live at
`z-index: 2147483647` on `document.documentElement`. Any overlay is detectable by
a determined page regardless of naming (position, size, event ordering), so
obfuscating the id buys nothing while breaking the documented contract that the
bridge and selector generator rely on.

### R3 — "Forgeable `data-bugpin-ui` capture-exclusion marker" *(security #5)* — same contract, negligible impact
Same PROTOCOL §5 clause. The only exploit is a page tagging its own elements so
its own clicks are omitted from *your* repro steps — a self-inflicted denial of
diagnostics with no privacy or integrity consequence. Tightening it would mean
inventing cross-content-script shared state that PROTOCOL does not define.

### R4 — "`hydrate` must reject the whole session" — partially rejected in favour of sanitising
The underlying defect (C9) is real and fixed, but rejecting an entire session
because one event lost its `ts` would throw away everything the user captured.
Dropping only the malformed entries preserves the rest, which is the behaviour a
bug-capture tool should have.

### R5 — MV3 lifecycle report's "CRITICAL" rating on debounced persistence
Downgraded, see C11. The fix was applied to the annotation path only; the
severity claim itself is rejected.

---

## 3b. Verified in a real Chromium (2026-08-10)

`test/browser-loadtest.mjs` loads the unpacked extension into a real Chromium
(Playwright, `channel: 'chromium'`, full browser — the default headless shell
cannot load extensions), serves a local test page, and drives a whole session:
start → click/type/failed-fetch/console-error → annotate → save a note → export.
**21/21 checks pass.** It proves items 1, 2, 5, 6, 9, 12 from the list below,
which are struck from it accordingly.

Confirmed by that run: the manifest parses, the service worker starts with no
console errors, content scripts inject, `[data-testid]` selector generation
wins, the element crop is correct, no BugPin UI appears in either screenshot,
the folder is named from the note, all 8 text files plus both JPEGs are written,
and neither the password nor a URL token survives into any exported file.

Two defects it caught, both since fixed:

- **Chrome renamed three exports.** `data:text/plain` disagreed with the
  filename extension, so `report.md` → `report.txt`, `e2e.spec.ts` →
  `e2e.spec.txt`, `session.json` → `session.txt`. `lib/downloads.js` now serves
  each extension its matching MIME type (`text/markdown`, `application/json`),
  falling back to `application/octet-stream`, which Chrome leaves alone. This is
  exactly the risk item 6 flagged as unfixable-without-a-browser.
- **The status chip appeared in every evidence screenshot**, reading a stale
  note count. `content-annotate.js` now hides the whole overlay — chip included
  — before the capture and restores it after.

Two export defects were also visible in the produced files and fixed:
annotation headings were `##` inside a `##` section (now `###`), and the
generated spec did `fill('«redacted»')`, which would type the placeholder into
the field (now a `process.env.BUGPIN_SECRET` line with a TODO).

## 4. Still NOT verified — needs a human in a real Chrome

The Chromium harness (§3b) covers the load, the crop, the export layout, the
`data:` downloads and redaction end to end. What remains needs either the real
Chrome UI (the popup, the keyboard command) or a scenario the harness does not
stage.

1. **The popup and options pages.** The harness drives the extension by message,
   never by clicking `popup.html`. Open the popup: confirm the status headline,
   the note count ticking up, the export path line, and that Options saves.
2. **The `Cmd/Ctrl+Shift+E` command.** `chrome.commands` cannot be triggered by
   synthesized input, so annotate mode has only ever been toggled by message.
3. **`conflictAction: 'overwrite'` (C5).** Export, add a second annotation,
   export again. Confirm one folder, no `report (1).md`, and that `report.md`
   holds the second export with working image links.
4. **Wrong-tab screenshot guard (C6).** Annotate, then switch tabs while a
   capture is queued. The annotation should save with null shots rather than a
   screenshot of the unrelated tab.
5. **Early `SET_MODE` buffering (C8).** Hit the shortcut the instant a heavy page
   finishes loading; the overlay must actually activate, not just the badge.
6. **Tab-close stop (C7).** Start a session, close the tab without opening the
   popup. The badge should clear and the session should still export.
7. **Blob-rule false positives (C2).** `console.error` a git SHA, a 32-char hex
   id and a stack trace with an absolute path; all three must survive intact,
   while a mixed-case 40-char API key is redacted.
8. **Storage quota (C4).** 25 annotations on a large viewport with no
   `QUOTA_BYTES` error, then Discard and confirm every `bugpin.shot.N` key is
   gone.
9. **Pin restore across a reload (`RESTORE_PINS`).** The harness annotates once
   and exports; it never reloads the page to check the pins come back.
10. **Multiple annotations and pin layout.** Only the single-annotation path has
    been exercised. Place several, scroll, resize, and confirm the pins track
    their elements.

Content scripts still have no unit tests — PROTOCOL §7 mandates them only for
the four pure modules. Their behaviour is now covered by the browser harness
rather than by reading alone.

## 5. Files changed

| File | Change |
| --- | --- |
| `lib/redact.js` | Narrowed `BLOB_RE` (C2) |
| `lib/capture-store.js` | `hydrate` sanitising, `nextAnnotationIndex`, client marker `ts` (C9, C10) |
| `lib/export.js` | Control-char stripping, non-finite `ts` guards (C12, C9) |
| `lib/downloads.js` | `conflictAction: 'overwrite'` (C5) |
| `lib/shots.js` | Active-tab re-check before every capture (C6) |
| `background.js` | Non-poisoning persister, orphaned shot cleanup, annotation flush, `tabs.onRemoved` (C3, C4, C11, C7) |
| `content-bridge.js` | `scrubUrl` on console + step events, scrubbed step label (C1) |
| `content-annotate.js` | Redaction wiring, synchronous listener + buffering, invalidated-context message (C1, C8, C14) |
| `content-console-inject.js` | Snapshot `slice`/`WeakSet`/`WeakMap` (C13) |
| `manifest.json` | `unlimitedStorage` (C4) |
| `PROTOCOL.md` | 3 clarifications: §3 marker `ts`, §4 overwrite, §5 redaction scope + blob rule + control chars |
| `README.md` | Corrected header claim, documented `unlimitedStorage` (C15, C4) |
| `test/redact.test.mjs` | 2 tests rewritten, 4 added |
| `test/capture-store.test.mjs` | 6 tests added |
| `test/export.test.mjs` | 7 tests added |

### Changed afterwards, from the Chromium run (§3b)

| File | Change |
| --- | --- |
| `lib/downloads.js` | Per-extension MIME so Chrome stops renaming `.md`/`.ts`/`.json` |
| `lib/export.js` | Annotation headings `##` → `###`; redacted values become a `process.env` placeholder in `e2e.spec.ts` |
| `content-annotate.js` | Hide the status chip too before a capture, restore after |
| `manifest.json` | Real PNG icon set wired up (`icons` + `action.default_icon`) |
| `tools/make-icons.mjs` | New — dependency-free PNG rasterizer for the icon |
| `test/browser-loadtest.mjs` | New — the 21-check Chromium harness |
| `test/export.test.mjs` | 1 test rewritten (heading level), 1 added (redacted fill) |
