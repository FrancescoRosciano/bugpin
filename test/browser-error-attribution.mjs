/**
 * The MAIN-world console patch must not make Chrome blame the page's own
 * console.warn/error on BugPin in chrome://extensions → Errors.
 *
 *   npm run test:browser:errors
 *
 * Chrome files a console message under an extension when the top stack frame's
 * script URL is chrome-extension://<id>/…, and with the patch installed that
 * frame is always content-console-inject.js. Developer mode and the
 * per-extension "Collect errors" toggle are switched on first: a
 * --load-extension install is not collected by default, unlike Load unpacked.
 */
import { createReporter, launchWithExtension, messenger, startTestServer, sleep } from './browser/harness.mjs';

const { check, summary } = createReporter();
const { server, origin } = await startTestServer();
const { context, page, worker, extensionId } = await launchWithExtension();

if (!worker) {
  check('service worker started', false, 'no service worker registered');
  await context.close();
  server.close();
  process.exit(1);
}
const send = messenger(worker);

const extPage = await context.newPage();
await extPage.goto('chrome://extensions/');
await extPage.evaluate(
  () => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r))
);
await extPage.evaluate(
  (id) => new Promise((r) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true }, r)),
  extensionId
);

await page.bringToFront();
await page.goto(origin, { waitUntil: 'load' });
await sleep(400);
const started = await send({ type: 'bugpin:start' });
check('session started', Boolean(started && started.recording), JSON.stringify(started));
await page.reload({ waitUntil: 'load' });
await sleep(1200);

// Control: an error BugPin itself raises on the same page must still be listed,
// so an empty list cannot pass just because collection silently stayed off.
await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'bugpin:restore-pins',
    annotations: [{ index: 1, selector: '[[[not-a-selector', note: 'control' }],
  });
});
await sleep(800);

const info = await extPage.evaluate(
  (id) => new Promise((r) => chrome.developerPrivate.getExtensionInfo(id, r)),
  extensionId
);
const listed = (info.runtimeErrors ?? []).map((e) => `${e.message} @ ${e.source}`);
const captured = await worker.evaluate(async () => {
  const session = (await chrome.storage.local.get('bugpin.session'))['bugpin.session'];
  return (session?.events ?? []).filter((e) => e.kind === 'console').map((e) => e.text);
});

check('error collection active for BugPin', info.errorCollection?.isActive === true, JSON.stringify(info.errorCollection));
check('page console.error still captured in the session',
  captured.some((t) => t.includes('BOOM: something went wrong in checkout')), `${captured.length} console events`);
check('page console.error not listed as a BugPin error',
  !listed.some((l) => l.includes('BOOM')), listed.filter((l) => l.includes('BOOM')).join(' || '));
check("BugPin's own content-script error still listed",
  listed.some((l) => l.includes('invalid stored selector') && l.includes('/content-annotate.js')), listed.join(' || '));

await context.close();
server.close();
process.exit(summary() ? 1 : 0);
