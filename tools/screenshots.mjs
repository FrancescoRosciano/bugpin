/**
 * Regenerates the README screenshots by driving the real extension.
 *
 *   npm run screenshots
 *
 * Loads BugPin unpacked into a real Chromium (same harness the browser tests
 * use), serves a small demo app with a planted bug, records one full session
 * against it — activity, three annotations, export — and photographs each
 * surface along the way. Everything written to docs/screenshots/ is a capture
 * of the shipping UI, so a stale image means this script was not re-run.
 *
 * Needs Playwright with the full `chromium` channel; point BUGPIN_PLAYWRIGHT at
 * one when this repo has none of its own.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT_DIR, launchWithExtension, messenger, sleep } from '../test/browser/harness.mjs';
import { renderMarkdown } from './md-preview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const DEMO = readFileSync(join(HERE, 'demo', 'index.html'), 'utf8');

const VIEWPORT = { width: 1180, height: 940 };

// The export path is legible in the popup screenshot, so the run happens under
// a fixed, boring directory rather than a per-user mkdtemp hash.
const BASE_DIR = platform() === 'win32' ? join(tmpdir(), 'bugpin-demo') : '/tmp/bugpin-demo';

/**
 * Playwright's `deviceScaleFactor` only changes what the renderer reports;
 * `chrome.tabs.captureVisibleTab` still hands back a 1x bitmap, which makes the
 * extension's DPR-aware element crop land outside the image. Forcing the scale
 * factor on the browser itself keeps capture and devicePixelRatio in agreement,
 * the way they are on a real retina display.
 */
const RETINA = {
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--force-device-scale-factor=2',
  ],
};
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/**
 * Serves the demo app, its two API endpoints (one empty 200 that triggers the
 * planted TypeError, one 500 that shows up as a network failure), and — once
 * an export exists — the report rendered as HTML with its shots alongside.
 */
function startDemoServer(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/api/billing/subscription') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (path === '/api/billing/sync') {
      req.socket.destroy();
      return;
    }
    if (path === '/api/billing/contact') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"contact_update_failed"}');
      return;
    }
    if (path === '/report' && state.exportDir) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderMarkdown(readFileSync(join(state.exportDir, 'report.md'), 'utf8')));
      return;
    }
    if (path.startsWith('/shots/') && state.exportDir) {
      const file = join(state.exportDir, path.slice(1));
      if (existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DEMO);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

const shot = async (page, name, options = {}) => {
  await page.screenshot({ path: join(OUT, `${name}.png`), ...options });
  console.log(`  wrote docs/screenshots/${name}.png`);
};

/**
 * Trims the viewport to the document so no screenshot carries dead space.
 * `scrollHeight` is no use here — it never reports less than the viewport — so
 * the body's own box, margins included, is what gets measured.
 */
async function fitToContent(page, width) {
  const height = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return document.body.getBoundingClientRect().height +
      parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  });
  await page.setViewportSize({ width, height: Math.ceil(height) });
  await sleep(250);
}

/** Opens the note composer on an element and leaves it open with text typed. */
async function openNote(page, selector, note) {
  await page.hover(selector);
  await sleep(300);
  await page.click(selector);
  await sleep(400);
  await page.keyboard.type(note, { delay: 12 });
  await sleep(250);
}

async function saveNote(page) {
  await page.keyboard.press('Enter');
  await sleep(2200);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const state = { exportDir: null };
const { server, origin } = await startDemoServer(state);
const { context, page, worker, extensionId, downloads } = await launchWithExtension({
  baseDir: BASE_DIR,
  contextOptions: RETINA,
});

if (!worker) {
  console.error('no service worker — extension failed to load');
  await context.close();
  server.close();
  process.exit(1);
}
const send = messenger(worker);

// ---- record a session against the demo app -------------------------------

await page.setViewportSize(VIEWPORT);
await page.goto(origin, { waitUntil: 'load' });
await sleep(500);

// The demo app is a full-height grid, so <main> always stretches to the
// viewport and cannot report the real content height. The bottom of its last
// child can. All three page shots then share one frame.
const contentHeight = await page.evaluate(() => {
  const main = document.querySelector('main');
  const padding = parseFloat(getComputedStyle(main).paddingBottom);
  return Math.ceil(main.lastElementChild.getBoundingClientRect().bottom + padding);
});
await page.setViewportSize({ width: VIEWPORT.width, height: contentHeight });
await sleep(300);
await send({ type: 'bugpin:start' });
await sleep(300);

await page.click('#upgrade');          // console TypeError, empty-200 request
await sleep(600);
await page.click('#seats');            // console warning
await page.fill('#email', 'billing@northwind.test');
await page.fill('#vat', 'EU100200300');
await page.click('#saveContact');      // 500 — a network failure in the report
await sleep(900);

await send({ type: 'bugpin:toggle-annotate', on: true });
await sleep(600);

// 1 — annotate mode: hover highlight, selector tooltip, exit chip
await page.hover('#upgrade');
await sleep(500);
await shot(page, '01-annotate-mode');

// 2 — the note composer, mid-sentence
await openNote(page, '#upgrade', 'Upgrade does nothing — throws instead of opening checkout');
await shot(page, '02-note');
await saveNote(page);

// two more notes so the pins read as a real session
await openNote(page, 'tbody tr:nth-child(2) .status.unpaid', 'Unpaid invoice has no "pay now" action');
await saveNote(page);
await openNote(page, '#cancelPlan', 'Cancel skips the confirm dialog entirely');
await saveNote(page);

// 3 — numbered pins over the page. Leaving and re-entering annotate mode
// redraws the pins without a hover box, which the parked mouse would otherwise
// paint across whatever element it happens to sit on.
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(400);
await send({ type: 'bugpin:toggle-annotate', on: false });
await sleep(400);
await send({ type: 'bugpin:toggle-annotate', on: true });
await sleep(800);
await shot(page, '03-pins');

// ---- the popup, mid-session and after export -----------------------------

const popup = await context.newPage();
await popup.setViewportSize({ width: 320, height: 400 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
await sleep(1400);
await fitToContent(popup, 320);
await shot(popup, '04-popup');

await popup.click('#exportBtn');
await sleep(5000);
await fitToContent(popup, 320);
await shot(popup, '05-popup-exported');

// ---- options -------------------------------------------------------------

const options = await context.newPage();
await options.setViewportSize({ width: 700, height: 900 });
await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'load' });
await sleep(700);
await fitToContent(options, 700);
await shot(options, '06-options');

// ---- the exported report -------------------------------------------------
// Stop first: the overlay chip is injected into every tab while a session is
// annotating, and it has no business in a picture of the report.

await page.bringToFront();
await send({ type: 'bugpin:toggle-annotate', on: false });
await send({ type: 'bugpin:stop' });
await sleep(600);

const dirs = (existsSync(downloads) ? readdirSync(downloads) : []).filter((f) =>
  statSync(join(downloads, f)).isDirectory()
);
if (dirs.length === 0) {
  console.error('export produced no folder — report screenshot skipped');
} else {
  state.exportDir = join(downloads, dirs[0]);
  console.log(`  export: ${dirs[0]}`);
  const report = await context.newPage();
  await report.setViewportSize({ width: 900, height: 1040 });
  await report.goto(`${origin}/report`, { waitUntil: 'load' });
  await sleep(1200);
  await shot(report, '07-report');
}

await context.close();
server.close();
console.log(`\n${readdirSync(OUT).length} screenshots in docs/screenshots/`);
