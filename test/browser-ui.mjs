/**
 * Browser coverage for the parts the session harness skips: the popup page, the
 * options page, the registered keyboard command, and four runtime scenarios
 * (re-export, tab close, blob-rule false positives, multi-annotation + pins).
 *
 *   npm run test:browser:ui
 *
 * The popup is opened as an ordinary tab, which differs from a real toolbar
 * popup in one way: `chrome.tabs.query({active: true})` then sees the popup's
 * own tab, so "Start session" is exercised separately and last.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createReporter, launchWithExtension, messenger, startTestServer, annotate, sleep,
} from './browser/harness.mjs';

const { check, summary } = createReporter();
const { server, origin } = await startTestServer();
const { context, page, worker, swErrors, extensionId, downloads } = await launchWithExtension();

if (!worker) {
  check('service worker started', false, 'no service worker registered');
  await context.close();
  server.close();
  process.exit(1);
}
const send = messenger(worker);
const folders = () =>
  (existsSync(downloads) ? readdirSync(downloads) : []).filter((f) =>
    statSync(join(downloads, f)).isDirectory()
  );

// ---- the keyboard command is registered ---------------------------------

const commands = await worker.evaluate(() => chrome.commands.getAll());
const toggle = commands.find((c) => c.name === 'toggle-annotate');
check('toggle-annotate command registered', Boolean(toggle && toggle.shortcut), JSON.stringify(toggle));
// The keystroke itself is dispatched by the browser process, so no automation
// can fire it; what is testable is that Chrome accepted and bound the shortcut.

// ---- popup: idle state ---------------------------------------------------

await page.bringToFront();
await page.goto(origin, { waitUntil: 'load' });
await sleep(400);

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
await sleep(800);

const idle = await popup.evaluate(() => ({
  status: document.getElementById('status').textContent,
  detail: document.getElementById('statusDetail').textContent,
  primary: document.getElementById('primaryBtn').textContent,
  exportDisabled: document.getElementById('exportBtn').disabled,
  error: document.getElementById('error').textContent,
}));
check('popup idle: headline is Idle', idle.status.trim() === 'Idle', JSON.stringify(idle.status));
check('popup idle: export disabled', idle.exportDisabled === true);
check('popup idle: primary offers Start', /start/i.test(idle.primary), idle.primary);
check('popup idle: no error shown', idle.error.trim() === '', idle.error);

// ---- popup reflects a live session --------------------------------------

await page.bringToFront();
const started = await send({ type: 'bugpin:start' });
check('session bound to the test tab', Boolean(started?.recording), JSON.stringify(started?.tabId));

await page.reload({ waitUntil: 'load' });
await page.click('#danger');
await page.fill('#email', 'fra@example.com');
await page.fill('#pw', 'hunter2-secret');
await sleep(1200);

await send({ type: 'bugpin:toggle-annotate', on: true });
await sleep(500);
await annotate(page, '#danger', 'delete this');
await annotate(page, '#rename', 'rename is broken too');

const twoNotes = await send({ type: 'bugpin:status' });
check('two annotations stored', twoNotes?.annotationCount === 2, `count=${twoNotes?.annotationCount}`);

await popup.bringToFront();
await sleep(1500);
const live = await popup.evaluate(() => ({
  status: document.getElementById('status').textContent,
  detail: document.getElementById('statusDetail').textContent,
  primary: document.getElementById('primaryBtn').textContent,
  exportDisabled: document.getElementById('exportBtn').disabled,
  annotatePressed: document.getElementById('annotateBtn').getAttribute('aria-pressed'),
}));
check('popup live: headline shows the mode', /Annotating|Recording/.test(live.status), live.status);
check('popup live: detail counts notes', /2 notes/.test(live.detail), live.detail);
check('popup live: primary offers Stop', /stop/i.test(live.primary), live.primary);
check('popup live: export enabled', live.exportDisabled === false);
check('popup live: annotate button pressed', live.annotatePressed === 'true', String(live.annotatePressed));

// ---- popup drives the export --------------------------------------------

await popup.click('#exportBtn');
await sleep(4000);
const exportInfo = await popup.evaluate(() => {
  const el = document.getElementById('exportInfo');
  return { hidden: el.hidden, text: el.textContent, error: document.getElementById('error').textContent };
});
check('popup export: path line shown', exportInfo.hidden === false, exportInfo.text);
check('popup export: no error', exportInfo.error.trim() === '', exportInfo.error);
check('popup export: one folder on disk', folders().length === 1, folders().join(','));

const dir = folders()[0] ? join(downloads, folders()[0]) : null;
if (dir) {
  const shots = existsSync(join(dir, 'shots')) ? readdirSync(join(dir, 'shots')) : [];
  check('both annotations produced shots', shots.length === 4, shots.join(','));
  const consoleTxt = readFileSync(join(dir, 'console.txt'), 'utf8');
  check('git-SHA-shaped id survives redaction',
    consoleTxt.includes('4f3d2c1b9a8e7f6d5c4b3a2918273645'));
  check('stack-trace path survives redaction',
    consoleTxt.includes('/home/dev/projects/bugpin/lib/x.js'));
  check('sk- API key is redacted',
    !consoleTxt.includes('sk-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5Ab6'));
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  check('report.md carries both notes',
    report.includes('delete this') && report.includes('rename is broken too'));
}

// ---- re-export overwrites rather than uniquifying ------------------------

const before = dir ? readdirSync(dir).sort().join(',') : '';
await popup.click('#exportBtn');
await sleep(4000);
check('re-export keeps a single folder', folders().length === 1, folders().join(','));
if (dir) {
  const after = readdirSync(dir).sort().join(',');
  check('re-export does not uniquify filenames', after === before,
    after === before ? '' : `now: ${after}`);
}

// ---- pins survive a reload ----------------------------------------------

await page.bringToFront();
await page.reload({ waitUntil: 'load' });
await sleep(2000);
const hostAfterReload = await page.evaluate(() => Boolean(document.querySelector('[data-bugpin-ui]')));
check('overlay host re-injected after reload', hostAfterReload);
// The pins live in a closed shadow root, so no query can count them; the
// screenshot is the artifact to eyeball for pin restore (RESTORE_PINS).
await page.screenshot({ path: join(downloads, 'after-reload.png') });

// ---- options page --------------------------------------------------------

const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'load' });
await sleep(600);
await options.uncheck('#screenshots');
await options.fill('#maxEvents', '1234');
await options.click('#saveBtn');
await sleep(800);

const savedVisible = await options.evaluate(() => !document.getElementById('saved').hidden);
const storedOptions = await worker.evaluate(async () => (await chrome.storage.local.get('bugpin.options'))['bugpin.options']);
check('options: saved confirmation shown', savedVisible);
check('options: screenshots persisted off', storedOptions?.screenshots === false, JSON.stringify(storedOptions));
check('options: maxEvents persisted', storedOptions?.maxEvents === 1234, String(storedOptions?.maxEvents));

await options.click('#resetBtn');
await sleep(800);
const resetOptions = await worker.evaluate(async () => (await chrome.storage.local.get('bugpin.options'))['bugpin.options']);
check('options: reset restores defaults',
  resetOptions?.screenshots === true && resetOptions?.maxEvents === 5000, JSON.stringify(resetOptions));

// ---- closing the bound tab stops, but does not discard, the session ------

await page.close();
await sleep(1200);
// popup.html is an extension page, so its own main world has chrome.runtime —
// the test tab it used to speak through is gone.
const afterClose = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'bugpin:status' }));
check('closing the tab stops recording', afterClose?.recording === false, JSON.stringify(afterClose));
check('closing the tab keeps the captured data',
  (afterClose?.eventCount ?? 0) > 0 && (afterClose?.annotationCount ?? 0) === 2,
  `events=${afterClose?.eventCount} notes=${afterClose?.annotationCount}`);

// ---- popup can start a session on its own ------------------------------

await popup.bringToFront();
await sleep(1200);
await popup.click('#discardBtn');
await sleep(800);
await popup.click('#primaryBtn');
await sleep(1200);
const afterPopupStart = await popup.evaluate(() => ({
  status: document.getElementById('status').textContent,
  primary: document.getElementById('primaryBtn').textContent,
}));
check('popup Start begins a session', /Recording|Annotating/.test(afterPopupStart.status), afterPopupStart.status);
check('popup Stop is then offered', /stop/i.test(afterPopupStart.primary), afterPopupStart.primary);

check('no service-worker console errors', swErrors.length === 0, swErrors.slice(0, 3).join(' || '));

console.log(`\nartifacts: ${downloads}`);
await context.close();
server.close();
process.exit(summary() ? 1 : 0);
