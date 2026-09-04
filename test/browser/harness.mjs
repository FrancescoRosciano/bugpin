/**
 * Shared plumbing for the browser test scripts: launches a real Chromium with
 * BugPin loaded unpacked, serves a local test page, and exposes a way to talk
 * to the service worker the same way the extension's own pages do.
 *
 * Needs Playwright with the full `chromium` channel — the default headless
 * shell cannot load extensions. Override the module location with
 * BUGPIN_PLAYWRIGHT when this repo has no Playwright of its own.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collects PASS/FAIL lines without letting one failure abort the run. */
export function createReporter() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    return failed.length;
  };
  return { check, summary };
}

export const TEST_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BugPin test page</title></head>
<body style="font:16px system-ui;padding:40px">
  <h1 id="title">Account settings</h1>
  <button id="danger" data-testid="delete-account">Delete account</button>
  <button id="rename">Rename workspace</button>
  <input id="email" name="email" placeholder="email" />
  <input id="pw" type="password" name="password" />
  <p id="footer" style="margin-top:400px">footer text</p>
  <script>
    console.log('page booted');
    console.error('BOOM: something went wrong in checkout');
    console.error('order 4f3d2c1b9a8e7f6d5c4b3a2918273645 failed at /home/dev/projects/bugpin/lib/x.js');
    console.error('key sk-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5Ab6 rejected');
    fetch('/missing-endpoint?token=abcdef1234567890').catch(() => {});
  </script>
</body></html>`;

export async function startTestServer() {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/missing-endpoint')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(TEST_PAGE_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Launches Chromium with the extension loaded and downloads pointed at a
 * scratch directory. `contextOptions` is merged last into the Playwright launch
 * options, so a caller can override the viewport or device scale factor (the
 * screenshot tool wants a 2x retina context; the tests want the default). Download handling is left on Chrome's 'default' behaviour:
 * Playwright's interception renames files to GUIDs, and CDP's 'allow' renames
 * them to download.<ext> — both would destroy the folder layout under test.
 */
export async function launchWithExtension({ baseDir, contextOptions = {} } = {}) {
  const base = baseDir || mkdtempSync(join(tmpdir(), 'bugpin-browser-'));
  const profile = join(base, 'chrome-profile');
  const downloads = join(base, 'downloads');
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    })
  );

  const { chromium } = await import(process.env.BUGPIN_PLAYWRIGHT || 'playwright');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
    ...contextOptions,
  });

  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const swErrors = [];
  worker?.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

  const extensionId = worker ? new URL(worker.url()).host : null;
  return { context, page, worker, swErrors, extensionId, downloads, base };
}

/**
 * Sends a message to the service worker from a tab's isolated extension world,
 * which is where the popup's messages come from too. `tabId` defaults to the
 * active tab, so START binds whatever tab the caller left focused.
 */
export function messenger(worker) {
  return async function send(message, tabId) {
    const id = tabId ?? (await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    }));
    if (id == null) throw new Error('no active tab to send from');
    const [{ result }] = await worker.evaluate(
      async ([target, msg]) =>
        chrome.scripting.executeScript({
          target: { tabId: target },
          func: (m) => chrome.runtime.sendMessage(m),
          args: [msg],
        }),
      [id, message]
    );
    return result;
  };
}

/** Drives the overlay: hover, click, type, save — the way a person would. */
export async function annotate(page, selector, note) {
  await page.hover(selector);
  await sleep(250);
  await page.click(selector);
  await sleep(400);
  await page.keyboard.type(note);
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(2200);
}
