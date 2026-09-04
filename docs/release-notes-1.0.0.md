First public release.

BugPin records a debugging session on the page you point it at — console output
and errors, network requests and their failures, navigations, and every click
and keystroke as a repro step — then exports the whole thing as one folder you
can hand to a person or to an AI coding agent.

## Install

Chrome does not allow installing an extension from a downloaded `.crx`, so this
release ships the unpacked source:

1. Download and unzip `bugpin-1.0.0.zip`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Pin BugPin to the toolbar.

Requires Chrome 120 or newer. There is no build step and no dependency to
install. Updating means downloading the next zip and reloading it.

## Using it

Press **Cmd+Shift+E** (Ctrl+Shift+E on Windows and Linux) on the page where the
bug is. That starts a session and drops you into annotate mode. Reproduce the
bug, click the element that is wrong, type what is wrong, press Enter. Repeat
for as many elements as you need, then open the popup and click **Export
session**. The folder lands in Downloads and its path goes to your clipboard.

Start an agent on `report.md` inside that folder.

## Privacy

Everything stays on your machine. BugPin makes no network requests of its own
and has no server, accounts, analytics or telemetry. Redaction is on by
default: password values are never recorded, API-key-shaped and token-shaped
strings are masked, secret-shaped query parameters are masked in every URL, and
request headers are never read at all. It is best-effort pattern matching
rather than a guarantee, so review an export before sharing it. Full policy in
[PRIVACY.md](https://github.com/FrancescoRosciano/bugpin/blob/main/PRIVACY.md).

## Verification

This build passes the repository's full suite: 135 unit tests, 21 browser
checks driving a real session end to end, and 32 popup, options and runtime
checks. The browser checks were run against the unpacked contents of this exact
zip, not against the working tree.
