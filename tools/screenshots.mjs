/**
 * Regenerates the product screenshots by driving the real extension.
 *
 *   npm run screenshots            README gallery  -> docs/screenshots/
 *   npm run screenshots:store      store listing   -> docs/store/
 *
 * Loads BugPin unpacked into a real Chromium (same harness the browser tests
 * use), serves a small demo app with a planted bug, records one full session
 * against it — activity, three annotations, export — and photographs each
 * surface along the way. Everything written out is a capture of the shipping
 * UI, so a stale image means this script was not re-run.
 *
 * The two profiles differ only in framing. The README wants retina images
 * cropped to their content; the Chrome Web Store requires every screenshot to
 * be exactly 1280x800 at 1x, and rejects anything else.
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
const DEMO = readFileSync(join(HERE, 'demo', 'index.html'), 'utf8');

const STORE = process.argv.includes('--store');
const OUT = join(ROOT, 'docs', STORE ? 'store' : 'screenshots');

/** Chrome Web Store screenshots must be exactly 1280x800 (or 640x400), at 1x. */
const STORE_FRAME = { width: 1280, height: 800 };
const README_FRAME = { width: 1180, height: 940 };
const FRAME = STORE ? STORE_FRAME : README_FRAME;
const SCALE = STORE ? 1 : 2;

// The export path is legible in the popup screenshot, so the run happens under
// a fixed, boring directory rather than a per-user mkdtemp hash.
const BASE_DIR = platform() === 'win32' ? join(tmpdir(), 'bugpin-demo') : '/tmp/bugpin-demo';

/**
 * Playwright's `deviceScaleFactor` only changes what the renderer reports;
 * `chrome.tabs.captureVisibleTab` still hands back a 1x bitmap, which makes the
 * extension's DPR-aware element crop land outside the image and come out one
 * pixel wide. Forcing the scale factor on the browser itself keeps capture and
 * devicePixelRatio in agreement, the way they are on a real display.
 */
const LAUNCH = {
  viewport: FRAME,
  deviceScaleFactor: SCALE,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    `--force-device-scale-factor=${SCALE}`,
  ],
};

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/**
 * Serves the demo app, its three API endpoints (an empty 200 that triggers the
 * planted TypeError, a 500, and one request killed at the transport layer), and
 * — once an export exists — the report rendered as HTML with its shots.
 */
function startDemoServer(state) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;

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

const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  wrote ${OUT.slice(ROOT.length + 1)}/${name}.png`);
};

/**
 * Trims the viewport to the document so no README screenshot carries dead
 * space. `scrollHeight` is no use here — it never reports less than the
 * viewport — so the body's own box, margins included, is what gets measured.
 * Store screenshots keep their fixed frame instead.
 */
async function fitToContent(page, width) {
  if (STORE) {
    await page.setViewportSize(STORE_FRAME);
    await sleep(250);
    return;
  }
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
  contextOptions: LAUNCH,
});

if (!worker) {
  console.error('no service worker — extension failed to load');
  await context.close();
  server.close();
  process.exit(1);
}
const send = messenger(worker);

// ---- record a session against the demo app -------------------------------

await page.setViewportSize(FRAME);
await page.goto(origin, { waitUntil: 'load' });
await sleep(500);

// The demo app is a full-height grid, so <main> always stretches to the
// viewport and cannot report the real content height. The bottom of its last
// child can. All three page shots then share one frame.
if (!STORE) {
  const contentHeight = await page.evaluate(() => {
    const main = document.querySelector('main');
    const padding = parseFloat(getComputedStyle(main).paddingBottom);
    return Math.ceil(main.lastElementChild.getBoundingClientRect().bottom + padding);
  });
  await page.setViewportSize({ width: FRAME.width, height: contentHeight });
  await sleep(300);
}

await send({ type: 'bugpin:start' });
await sleep(300);

await page.click('#upgrade');          // console TypeError, empty-200 request
await sleep(600);
await page.click('#seats');            // console warning
await page.fill('#email', 'billing@northwind.test');
await page.fill('#vat', 'EU100200300');
await page.click('#saveContact');      // a 500 and a killed connection
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
// A 320px popup cannot be framed at 1280x800 without padding it out with dead
// space, so the store profile drives the export from the popup but photographs
// only the surfaces that fill a frame.

const popup = await context.newPage();
await popup.setViewportSize({ width: 320, height: 400 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
await sleep(1400);
if (!STORE) {
  await fitToContent(popup, 320);
  await shot(popup, '04-popup');
  await popup.setViewportSize({ width: 320, height: 400 });
}

await popup.click('#exportBtn');
await sleep(5000);
if (!STORE) {
  await fitToContent(popup, 320);
  await shot(popup, '05-popup-exported');
}

// ---- options -------------------------------------------------------------

const options = await context.newPage();
await options.setViewportSize(STORE ? STORE_FRAME : { width: 700, height: 900 });
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
  await report.setViewportSize(STORE ? STORE_FRAME : { width: 900, height: 1040 });
  await report.goto(`${origin}/report`, { waitUntil: 'load' });
  await sleep(1200);
  await shot(report, '07-report');
}

await context.close();
server.close();
console.log(`\n${readdirSync(OUT).length} screenshots in ${OUT.slice(ROOT.length + 1)}/`);
