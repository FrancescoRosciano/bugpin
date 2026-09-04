# BugPin privacy policy

_Last updated: 4 September 2026_

BugPin is a Chrome extension that records a debugging session on a page you
choose and writes it to your own Downloads folder. This policy describes what
it handles and where that data goes.

## The short version

BugPin sends nothing anywhere. It makes no network requests of its own, has no
server, no analytics, no telemetry and no accounts. Everything it records stays
on your machine, in your browser's local storage and in your Downloads folder,
until you export it or discard it.

## What BugPin handles

While a session is recording on the tab you started it on, BugPin keeps the
following in a rolling in-memory buffer, persisted to `chrome.storage.local` so
the session survives the service worker restarting:

- Console output and uncaught errors from the page.
- Network request metadata — method, URL, status, duration and failure reason.
  Request and response **headers are never read**, so `Authorization`, `Cookie`
  and `Set-Cookie` never enter a session.
- Page navigations.
- Your clicks and typing on that page, as repro steps.
- For each annotation you make: your note, a CSS selector and XPath for the
  element, the page URL, and — unless you turn screenshots off — a screenshot of
  the visible tab and a cropped image of the element.

This can include personal information, because the page you are debugging can
contain personal information. That is why none of it leaves your machine.

## Redaction

Redaction is on by default and applied before anything is stored:

- Password field values are never recorded at all.
- Strings shaped like API keys, bearer tokens or JWTs are replaced with
  `«redacted»`.
- The values of query-string parameters named `token`, `key`, `secret`,
  `password`, `auth`, `session` or `sig` are masked in every URL BugPin records.

This is best-effort pattern matching, not a guarantee. Unusual secret formats
can slip through, and the matching is deliberately conservative so it does not
shred hex ids, commit SHAs or file paths in stack traces. Review an export
before you share it, especially if you turn redaction off.

## Where the data goes

- **In the browser**: `chrome.storage.local`, on your device. Cleared when you
  discard a session, and overwritten when you start a new one.
- **On disk**: one timestamped folder per export, written to your Downloads
  directory by the browser's own download mechanism.
- **Nowhere else.** BugPin has no remote endpoint to send data to.

## What BugPin does not do

- No data is sold or transferred to third parties.
- No data is used for advertising, profiling, creditworthiness or lending.
- No data is used for any purpose unrelated to producing your export.
- No remote code is loaded or executed.

## Permissions

Each permission BugPin requests, and why, is documented in the "Permissions"
section of the [README](README.md).

## Removing your data

Click **Discard** in the popup to drop the current session, or uninstall the
extension to remove its local storage entirely. Exported folders are ordinary
files in your Downloads directory — delete them like any other file.

## Contact

Questions or reports: open an issue at
<https://github.com/FrancescoRosciano/bugpin/issues>.
