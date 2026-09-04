# BugPin

BugPin is a Chrome MV3 extension for capturing and handing off debugging
sessions. Point at the element that's broken, say what's wrong, and export
the whole session — console output, network requests, navigation, a
click-by-click repro, and screenshots — as one folder.

Everything BugPin sees while a session is recording (console/errors,
network requests, navigations, clicks/inputs) is kept in a rolling buffer.
When you annotate an element it takes a screenshot, records a stable
selector for that element, and stamps a numbered pin. Exporting turns all
of that into a single self-contained folder you can drop straight into an
AI coding agent instead of writing up a bug report by hand.

## What it looks like

Annotate mode outlines whatever you hover and names the selector it would
record, so you can see what is about to be pinned before you click.

![BugPin annotate mode: the hovered button outlined in blue, its selector shown in a tooltip, and an exit chip in the corner](docs/screenshots/01-annotate-mode.png)

Clicking opens a note box on that element. Enter saves, Shift+Enter adds a
newline, Esc backs out without losing the session.

![The BugPin note box open on a button with a note typed into it](docs/screenshots/02-note.png)

Saved notes stay on the page as numbered pins for as long as annotate mode is
on, so it stays obvious what you have already covered.

![The demo page with three numbered BugPin pins on the elements that were annotated](docs/screenshots/03-pins.png)

The popup is the session's control surface — what is being captured, how much
of it there is, and the two ways out. After an export it shows where the folder
landed.

<table>
<tr>
<td><img alt="The BugPin popup mid-session, showing 14 events, 3 notes and an elapsed timer" src="docs/screenshots/04-popup.png" width="320" /></td>
<td><img alt="The BugPin popup after an export, showing the folder path it wrote" src="docs/screenshots/05-popup-exported.png" width="320" /></td>
</tr>
</table>

`report.md` is what the export is for: every annotation with its selector, its
screenshots and the events that surrounded it, then the full timeline
underneath.

![The top of an exported report.md: session summary, the first annotation with its element crop and full-page shot, and the nearby console and network events](docs/screenshots/07-report.png)

Screenshots, buffer size and redaction are all switchable on the options page.

![The BugPin options page, showing the capture and privacy settings at their defaults](docs/screenshots/06-options.png)

## Load unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's root folder.
4. Pin the BugPin icon to the toolbar if you want one-click access.

Requires Chrome 120+. No build step — the extension runs directly from
these files.

## Flow: capture → annotate → export

1. Navigate to the page where the bug happens.
2. Open the popup and click **Start session** — or just press
   **⌘⇧E / Ctrl+Shift+E**, which starts a session implicitly if one isn't
   running yet and drops you straight into annotate mode.
3. Reproduce the bug normally. BugPin records console/error output, network
   requests, page navigations, and your clicks/inputs in the background —
   you don't need to do anything for this part.
4. When you hit the broken thing, toggle **annotate mode** (popup button or
   ⌘⇧E), hover the offending element, click it, type a note, and press
   **Enter** to save (**Shift+Enter** for a newline). Repeat for as many
   elements as you need. **Esc** exits annotate mode without losing the
   session.
5. Open the popup and click **Export session**. BugPin writes one
   timestamped folder to your Downloads directory and copies its path to
   your clipboard.
6. Click **Discard** instead if you want to throw the session away without
   exporting.

## Export folder layout

```
MM-DD-HH.MM-<label>/
  report.md          full merged report: annotations inline w/ images, then timeline
  annotations.txt    one block per note: index, note, selector, xpath, label, url, ts
  console.txt        one line per console/error event
  network.txt        one line per request; failures marked `FAIL`
  e2e-helper.txt     numbered human-readable repro steps (clicks/typing/navigation)
  e2e.spec.ts        Playwright test skeleton generated from the same steps
  system-info.txt    SystemInfo, plus event counts and droppedOldestEvents
  session.json       the raw serialized Session (source of truth)
  shots/01-full.jpg  full visible-tab screenshot at annotation time
  shots/01-element.jpg  cropped element (rect + padding)
```

`label` is a slug of the first annotation's note, falling back to the last
console error, then `session`.

## Feeding it to an AI agent

Point your coding agent at the exported folder and start with `report.md`
— it's the merged, human-readable view with annotations and their
screenshots inline, followed by the full event timeline. If the agent
needs more than that, `session.json` is the complete raw record everything
else was derived from, and `e2e.spec.ts` gives it a runnable Playwright
skeleton for reproducing the bug.

## Permissions

- **`<all_urls>` host permission + `webRequest`** — BugPin's whole point is
  capturing on whatever page the bug shows up on, including third-party
  requests the page depends on. A fixed allowlist of origins would silently
  stop capturing on any site not on the list, which defeats the tool. To
  narrow this, edit `host_permissions` in `manifest.json` to the specific
  origin(s) you actually debug (e.g. `["https://app.example.com/*"]`)
  before loading unpacked — capture then only works on those origins.
- **`webNavigation`** — records page navigations for the event timeline.
- **`tabs`** — identifies and targets the tab a session is bound to.
- **`scripting`** — programmatic script injection alongside the manifest's
  static content scripts.
- **`downloads`** — writes the export folder to your Downloads directory.
- **`storage`** / **`unlimitedStorage`** — persists the session and options in
  `chrome.storage.local` so a session survives the service worker being torn
  down and restarted. Screenshots are held there as base64 JPEGs until export
  or discard, which can exceed the default 10 MB quota; `unlimitedStorage`
  lifts it (it stores nothing outside your machine).
- **`clipboardWrite`** — copies the export folder path after a successful
  export.

## Privacy

Everything stays on your machine. Capture, storage
(`chrome.storage.local`), and export (your Downloads folder) are all
local; BugPin makes no network calls of its own and uploads nothing.

Redaction (`lib/redact.js`) is applied before anything is stored: password
field values are never recorded, and strings shaped like API keys, bearer
tokens or JWTs are replaced with `«redacted»`. Sensitive query-string
values (`token`, `key`, `secret`, `password`, `auth`, `session`, `sig`) are
masked in every URL BugPin records — network requests, navigations,
console/step events and annotations alike. Request and response headers are
never captured at all: `lib/network-capture.js` reads no headers, so
`Authorization`/`Cookie`/`Set-Cookie` never enter a session in the first
place.

This is **best-effort pattern matching, not a guarantee** — unusual secret
formats can slip through, and the matching is deliberately conservative
about long opaque strings so it doesn't shred hex ids, git SHAs or file
paths in stack traces. Review an export folder yourself before sharing it,
especially if you disable the redaction option.

## Tests

Pure modules (`lib/selector.js`, `lib/capture-store.js`, `lib/export.js`,
`lib/redact.js`) are tested with Node's built-in test runner — no install
step required:

```
npm test
```

which runs `node --test test/*.test.mjs`.

The rest of the extension — manifest parsing, content-script injection, the
overlay, screenshots, `data:` downloads and the export layout — is covered by a
browser harness that loads BugPin unpacked in a real Chromium and drives one
full session (start → activity → annotate → save → export), asserting 21 things
about the result:

```
npm run test:browser      # 21 checks: load, capture, annotate, shots, export
npm run test:browser:ui   # 32 checks: popup, options, re-export, tab close, pins
```

It needs Playwright with the full `chromium` channel; the default headless
shell cannot load extensions. If this repo has no Playwright of its own, point
it at one:

```
BUGPIN_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs npm run test:browser
```

Toolbar icons are generated, not committed by hand — `npm run icons` rasterizes
`icons/icon{16,32,48,128}.png` with no dependencies.

The README screenshots are generated too. `npm run screenshots` loads BugPin
into the same real Chromium the browser tests use, records one session against
the demo app in `tools/demo/`, and photographs each surface as it goes, so a
stale image means the script was not re-run rather than that the UI was
described from memory. It needs the same Playwright the browser tests do.
