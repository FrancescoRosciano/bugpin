# Distributing BugPin

Three ways to get BugPin onto someone's machine. Only one of them costs money,
and it is not the one you have to start with.

| Route | Cost | Who can install | Auto-updates |
|---|---|---|---|
| GitHub release, loaded unpacked | free | anyone willing to turn on Developer mode | no |
| Microsoft Edge Add-ons | free | Edge users, one click | yes |
| Chrome Web Store | **$5 one-time** | Chrome users, one click | yes |

The $5 is a one-time Google developer registration fee. It is mandatory, covers
every extension you ever publish under that account, and has no free tier and
no waiver. Until it is paid, the Chrome Web Store is closed.

**A self-hosted `.crx` is not a fourth option.** Chrome on Windows and macOS
refuses to install a `.crx` that did not come from the Web Store, and disables
it if you sideload it anyway. Only two things work outside the store: loading an
unpacked folder with Developer mode on, or force-installing through enterprise
policy on managed devices.

## Build the artifact

`npm run package` writes `dist/bugpin-<version>.zip` from an explicit allowlist —
the manifest, the extension's scripts and pages, `lib/`, and the four icons.
Tests, tooling, the demo app and the docs stay out. It refuses to build if
`manifest.json` and `package.json` disagree on the version, if a listed file is
missing, or if the manifest references something the archive would not contain.

Verify the artifact rather than the working tree before publishing it anywhere:

```
npm run package
rm -rf /tmp/bugpin-pkg && unzip -q dist/bugpin-1.0.0.zip -d /tmp/bugpin-pkg
BUGPIN_EXT_DIR=/tmp/bugpin-pkg npm run test:browser
```

That loads the unzipped build into a real Chromium and drives a full session
against it — the same 21 checks the repository runs, pointed at the thing being
shipped.

## Route 1 — GitHub release

Free, works today, and the only route that needs nobody's approval.

```
npm run package
gh release create v1.0.0 dist/bugpin-1.0.0.zip \
  --title "BugPin 1.0.0" --notes-file docs/release-notes-1.0.0.md
```

Users then unzip it and follow the "Load unpacked" section of the
[README](../README.md). The cost is that Developer mode has to stay on and
there are no automatic updates — people upgrade by downloading the next zip.

## Route 2 — Microsoft Edge Add-ons

A real store listing, one-click install, automatic updates, and **no
registration fee**. It takes the same zip: Edge is Chromium, and an MV3
extension that runs in Chrome runs there unmodified.

Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview),
create a submission, upload the zip, and fill in the listing from the copy
below. The catch is reach — an Edge listing does not put BugPin in front of
Chrome users, who are most of the market for a debugging tool.

Verify the current fee situation yourself before committing; Microsoft can
change it, and a policy that was free is not guaranteed to stay free.

## Route 3 — Chrome Web Store

Blocked on the $5 fee. Everything else is ready. When and if you pay it:

1. Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Turn on 2-Step Verification for that Google account — the dashboard requires
   it before a listing can be published.
3. Verify a publisher contact email. An unverified address blocks publishing.
4. Upload the zip, fill in the listing below, and submit for review.

Review for a first submission that asks for broad host access usually takes
several days, and can take longer. Expect follow-up questions, most likely
about `<all_urls>`.

## Listing copy

Written for the Chrome Web Store's fields; Edge asks for the same things under
slightly different names.

**Extension name** (from `manifest.json`, 45 characters)

```
BugPin — annotate & export debugging sessions
```

**Short description / summary** (132 character limit; this is 115)

```
Point at an element, say what's wrong, then export console, network, E2E repro steps and screenshots as one folder.
```

**Category:** Developer Tools
**Language:** English

**Detailed description**

```
BugPin turns a debugging session into one folder you can hand to someone else —
or to an AI coding agent — instead of writing up a bug report by hand.

Start a session, reproduce the bug the way you normally would, then point at
whatever is broken and say what's wrong. BugPin was already recording: console
output and uncaught errors, network requests and their failures, page
navigations, and every click and keystroke as a repro step. Annotating an
element adds your note, a stable CSS selector and XPath for it, a full-tab
screenshot and a cropped shot of the element itself.

Exporting writes a single timestamped folder to your Downloads directory:

• report.md — the merged, human-readable report: every annotation with its
  screenshots and the events that surrounded it, then the full timeline
• annotations.txt — one block per note, with selector, xpath and URL
• console.txt — console and error output, errors first
• network.txt — one line per request, failures marked
• e2e-helper.txt — numbered, human-readable repro steps
• e2e.spec.ts — a runnable Playwright skeleton generated from those steps
• system-info.txt — browser, viewport and event counts
• session.json — the raw record everything else was derived from
• shots/ — the screenshots, referenced inline from report.md

Point a coding agent at the folder and start it on report.md.

PRIVACY

Everything stays on your machine. BugPin makes no network requests of its own,
has no server, no accounts, no analytics and no telemetry. Capture, storage and
export are all local.

Redaction runs before anything is stored: password field values are never
recorded, strings shaped like API keys, bearer tokens or JWTs are masked, and
secret-shaped query parameters (token, key, secret, auth and friends) are
masked in every URL. Request and response headers are never read at all, so
Authorization and Cookie never enter a session in the first place. This is
best-effort pattern matching rather than a guarantee — review an export before
sharing it.

KEYBOARD

Cmd+Shift+E (Ctrl+Shift+E on Windows and Linux) toggles annotate mode, and
starts a session if one isn't running yet. Enter saves a note, Shift+Enter adds
a newline, Esc leaves annotate mode without losing the session.

Open source under the MIT license:
https://github.com/FrancescoRosciano/bugpin
```

## Single purpose

Both stores require a one-sentence single-purpose statement:

```
BugPin captures a debugging session on a web page — console output, network
requests, navigation, user steps, and screenshots of elements the user
annotates — and exports it to the user's Downloads folder as a single report
folder.
```

## Permission justifications

One per permission, written to be pasted in.

| Permission | Justification |
|---|---|
| `host_permissions: <all_urls>` | A bug report is only useful on the page where the bug happens, which is any page the user chooses at the moment they hit it. Capture is inert until the user explicitly starts a session on a specific tab, and it stops when that session stops. A fixed origin allowlist would silently fail to capture on any site not on the list, which removes the extension's only function. |
| `webRequest` | Records the metadata of the requests the debugged page makes — method, URL, status, duration and failure reason — so the export can show which requests failed alongside the console errors. Observation only; no headers are read and no requests are modified or blocked. |
| `webNavigation` | Records page navigations during a session so the exported timeline and the generated repro steps show when the page moved. |
| `tabs` | Identifies the tab a session is bound to, so capture applies to that one tab and stops when it is closed, and targets screenshot capture at it. |
| `scripting` | Injects the annotation overlay into the session's tab on demand, alongside the manifest's static content scripts, including after a page reload. |
| `downloads` | Writing the export folder to the user's Downloads directory is the extension's output. |
| `storage` | Persists the session and the user's options so an in-progress session survives the service worker being torn down and restarted. |
| `unlimitedStorage` | Screenshots are held as base64 JPEGs in local storage until the user exports or discards, which routinely exceeds the default 10 MB quota. Nothing is stored outside the user's machine. |
| `clipboardWrite` | Copies the export folder's path after a successful export, so it can be pasted into a ticket or an agent. Off if the user turns the option off. |

## Data usage disclosures

BugPin transmits nothing off the device, so it collects no user data under
either store's definition. Confirm each answer against the current form before
submitting; the questions change.

- Certify that the data is **not** sold or transferred to third parties beyond
  the approved use cases.
- Certify that it is **not** used or transferred for purposes unrelated to the
  item's single purpose.
- Certify that it is **not** used or transferred to determine creditworthiness
  or for lending purposes.
- Privacy policy URL:
  <https://github.com/FrancescoRosciano/bugpin/blob/main/PRIVACY.md>

## Graphics

| Asset | Requirement | Where |
|---|---|---|
| Store icon | 128x128 PNG | `icons/icon128.png` |
| Screenshots | 1280x800 PNG, at least one, up to five | `docs/store/` — regenerate with `npm run screenshots:store` |
| Small promo tile | 440x280 PNG, optional | `docs/store/promo-440x280.png` |
| Marquee promo tile | 1400x560 PNG, optional | `docs/store/promo-1400x560.png` |

Both stores reject screenshots that are not exactly 1280x800 (or 640x400),
which is why the store profile is a separate npm script from the README
gallery. `npm run promo` regenerates the two tiles.

## Before publishing anywhere

- [ ] `npm test`, `npm run test:browser`, `npm run test:browser:ui` all pass
- [ ] `npm run package` succeeds and the unzipped build passes the browser suite
- [ ] Version bumped in **both** `manifest.json` and `package.json`
- [ ] Screenshots regenerated if any UI changed
- [ ] Store routes only: publisher contact email verified, 2-Step Verification on
