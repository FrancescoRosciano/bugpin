/**
 * Loads BugPin unpacked in a real Chromium and drives one full session:
 * start -> page activity -> annotate -> save note -> export.
 * Everything is reported as PASS/FAIL lines; no assertion aborts the run early.
 *
 *   node test/browser-loadtest.mjs
 *
 * Needs Playwright with the full `chromium` channel (not headless_shell, which
 * cannot load extensions). Point BUGPIN_PLAYWRIGHT at an install if this repo
 * has none of its own:
 *
 *   BUGPIN_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/browser-loadtest.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, statSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.BUGPIN_PLAYWRIGHT || 'playwright');

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BUGPIN_TEST_DIR || mkdtempSync(join(tmpdir(), 'bugpin-loadtest-'));
const PROFILE = join(BASE, 'chrome-profile');
const DOWNLOADS = join(BASE, 'downloads');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(join(PROFILE, 'Default'), { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
writeFileSync(
  join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true },
    profile: { exit_type: 'Normal', exited_cleanly: true },
  })
);

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BugPin test page</title></head>
<body style="font:16px system-ui;padding:40px">
  <h1 id="title">Account settings</h1>
  <button id="danger" data-testid="delete-account">Delete account</button>
  <input id="email" name="email" placeholder="email" />
  <input id="pw" type="password" name="password" />
  <script>
    console.log('page booted');
    console.error('BOOM: something went wrong in checkout');
    fetch('/missing-endpoint?token=abcdef1234567890').catch(() => {});
  </script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url.startsWith('/missing-endpoint')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
});

// Playwright intercepts downloads and renames every file to a GUID, which would
// destroy the folder/filename layout the extension asks Chrome for. Hand control
// back to Chrome so the profile's download directory and the filenames apply.
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
// 'default' (not 'allow') is the only mode where Chrome keeps the filename the
// extension asked for — 'allow' renames everything to download.<ext>.
await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
check('service worker started', Boolean(worker), worker ? worker.url() : 'no service worker registered');
if (!worker) {
  await context.close();
  server.close();
  process.exit(1);
}

const swErrors = [];
worker.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
check('manifest parsed by Chrome', manifest.name.startsWith('BugPin'), `${manifest.name} ${manifest.version}`);

await page.bringToFront();
await page.goto(ORIGIN, { waitUntil: 'load' });
await sleep(500);

/** Runs inside the page's isolated extension world, which has chrome.runtime. */
const send = async (message) => {
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  const [{ result }] = await worker.evaluate(
    async ([id, msg]) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        func: (m) => chrome.runtime.sendMessage(m),
        args: [msg],
      }),
    [tabId, message]
  );
  return result;
};

const started = await send({ type: 'bugpin:start' });
check('session started', Boolean(started && started.recording), JSON.stringify(started));

await page.reload({ waitUntil: 'load' });
await page.click('#danger');
await page.fill('#email', 'fra@example.com');
await page.fill('#pw', 'hunter2-secret');
await sleep(1200);

const afterActivity = await send({ type: 'bugpin:status' });
check('events captured', (afterActivity?.eventCount ?? 0) > 0, `eventCount=${afterActivity?.eventCount}`);

const annotateOn = await send({ type: 'bugpin:toggle-annotate', on: true });
check('annotate mode on', Boolean(annotateOn && annotateOn.annotating), JSON.stringify(annotateOn));
await sleep(600);

const overlayPresent = await page.evaluate(() => Boolean(document.querySelector('[data-bugpin-ui]')));
check('overlay host injected', overlayPresent);

await page.hover('#danger');
await sleep(300);
await page.click('#danger');
await sleep(500);
await page.keyboard.type('delete this');
await sleep(200);
await page.keyboard.press('Enter');
await sleep(2500);

const afterNote = await send({ type: 'bugpin:status' });
check('annotation saved', (afterNote?.annotationCount ?? 0) === 1, `annotationCount=${afterNote?.annotationCount}`);

const stored = await worker.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const session = all['bugpin.session'];
  const shotKeys = Object.keys(all).filter((k) => k.startsWith('bugpin.shot.'));
  const ann = session?.annotations?.[0] ?? null;
  return {
    note: ann?.note ?? null,
    selector: ann?.selector ?? null,
    shotKeys,
    shotBytes: shotKeys.length ? JSON.stringify(all[shotKeys[0]]).length : 0,
    kinds: [...new Set((session?.events ?? []).map((e) => e.kind))],
    pwValues: (session?.events ?? [])
      .filter((e) => e.kind === 'step' && typeof e.value === 'string')
      .map((e) => e.value),
  };
});
check('note text stored', stored.note === 'delete this', JSON.stringify(stored.note));
check('selector uses data-testid', String(stored.selector).includes('delete-account'), stored.selector);
check('screenshot blob stored', stored.shotKeys.length === 1 && stored.shotBytes > 5000,
  `${stored.shotKeys.join(',')} ${stored.shotBytes}B`);
check('console+network+step captured',
  ['console', 'network', 'step'].every((k) => stored.kinds.includes(k)), stored.kinds.join(','));
check('password never stored raw', !stored.pwValues.some((v) => v.includes('hunter2')), stored.pwValues.join(' | '));

const exported = await send({ type: 'bugpin:export' });
check('export reported ok', Boolean(exported && exported.ok), JSON.stringify(exported).slice(0, 300));
await sleep(3000);

const folders = existsSync(DOWNLOADS)
  ? readdirSync(DOWNLOADS).filter((f) => statSync(join(DOWNLOADS, f)).isDirectory())
  : [];
check('export folder created', folders.length === 1, folders.join(',') || `(none in ${DOWNLOADS})`);
if (folders.length) {
  const dir = join(DOWNLOADS, folders[0]);
  const files = readdirSync(dir);
  const shots = existsSync(join(dir, 'shots')) ? readdirSync(join(dir, 'shots')) : [];
  const want = ['report.md', 'annotations.txt', 'console.txt', 'network.txt', 'e2e-helper.txt',
    'e2e.spec.ts', 'system-info.txt', 'session.json'];
  const missing = want.filter((f) => !files.includes(f));
  check('all 8 text files written', missing.length === 0, missing.length ? `missing ${missing}` : files.join(','));
  check('shots written', shots.length === 2, shots.join(','));
  check('folder named from the note', folders[0].endsWith('-delete-this'), folders[0]);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  check('report.md contains the note', report.includes('delete this'));
  const grep = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  check('raw token redacted in export', !grep.includes('abcdef1234567890'),
    grep.includes('abcdef1234567890') ? 'token leaked' : '');
  check('password redacted in export', !grep.includes('hunter2'));
  console.log(`\nexport folder: ${dir}\nfiles: ${files.join(', ')}${shots.length ? ` | shots: ${shots.join(', ')}` : ''}`);
}

check('no service-worker console errors', swErrors.length === 0, swErrors.slice(0, 3).join(' || '));

await context.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
