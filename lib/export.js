/**
 * Pure export-file generation for a serialized Session (PROTOCOL.md §4).
 * No chrome.* calls — everything here is string-in, string-out so it can run
 * unmodified under `node --test`. The caller (background.js) is responsible
 * for writing files to disk and attaching screenshot binaries.
 */

const MAX_LABEL_LEN = 40;
const CONTEXT_EVENTS = 3;

/**
 * C0/C1 control characters except TAB and LF. Page-controlled strings reach
 * console.txt / network.txt / annotations.txt verbatim, and those files get
 * read with `cat`/`less` — a raw ESC sequence in a console message would then
 * be interpreted by the terminal rather than shown. CR is stripped too (it
 * lets a line overwrite the previous one).
 */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function stripControl(value) {
  return String(value).replace(CONTROL_RE, '');
}

/** Default escaper for the plain-text files: control characters only. */
const plain = (value) => stripControl(value);

// ---------------------------------------------------------------- generic --

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function slugify(str) {
  const collapsed = String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return collapsed.slice(0, MAX_LABEL_LEN).replace(/-+$/g, '');
}

/** Escapes the two Markdown characters that can break a report.md layout. */
function escapeMd(value) {
  return stripControl(value).replace(/`/g, '\\`').replace(/\|/g, '\\|');
}

/** Escapes a value for embedding inside a single-quoted TS string literal. */
function escapeJsString(value) {
  return stripControl(
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r?\n/g, '\\n'),
  );
}

const UNKNOWN_CLOCK = '--:--:--.---';

function formatClock(ts) {
  if (!Number.isFinite(ts)) return UNKNOWN_CLOCK;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function formatTs(ts, startedAt) {
  if (!Number.isFinite(ts) || !Number.isFinite(startedAt)) return `${formatClock(ts)} (+?ms)`;
  const delta = ts - startedAt;
  const sign = delta < 0 ? '-' : '+';
  return `${formatClock(ts)} (${sign}${Math.abs(delta)}ms)`;
}

function formatDateTime(ts) {
  if (!Number.isFinite(ts)) return 'unknown';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(ts)}`;
}

/** Missing/corrupt `ts` sorts first instead of poisoning every comparison with NaN. */
function tsOf(evt) {
  return Number.isFinite(evt?.ts) ? evt.ts : 0;
}

/** Stable-sorts events by ts; equal timestamps keep original (insertion) order. */
function sortedEvents(session) {
  return [...(session.events ?? [])].sort((a, b) => tsOf(a) - tsOf(b));
}

function eventCounts(session) {
  const events = session.events ?? [];
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  return {
    total: events.length,
    console: count('console'),
    network: count('network'),
    step: count('step'),
    nav: count('nav'),
  };
}

function partitionFirst(events, predicate) {
  const match = [];
  const rest = [];
  for (const evt of events) {
    (predicate(evt) ? match : rest).push(evt);
  }
  return [...match, ...rest];
}

function consoleTimeline(session) {
  const evts = sortedEvents(session).filter((e) => e.kind === 'console');
  return partitionFirst(evts, (e) => e.level === 'error');
}

function networkTimeline(session) {
  const evts = sortedEvents(session).filter((e) => e.kind === 'network');
  return partitionFirst(evts, (e) => e.failed);
}

// -------------------------------------------------------- label / folder --

/**
 * @param {import('./capture-store.js').Session} session
 * @returns {string} first annotation note, else last console error text,
 *   else 'session'; slugified, never empty.
 */
export function slugLabel(session) {
  const annotations = session.annotations ?? [];
  const candidate = annotations.length > 0 ? annotations[0].note : lastConsoleErrorText(session);
  const slug = candidate ? slugify(candidate) : '';
  return slug || 'session';
}

function lastConsoleErrorText(session) {
  const errors = sortedEvents(session).filter((e) => e.kind === 'console' && e.level === 'error');
  return errors.length > 0 ? errors[errors.length - 1].text : undefined;
}

/**
 * @param {import('./capture-store.js').Session} session
 * @param {number|Date} [date] defaults to session.startedAt
 * @returns {string} 'MM-DD-HH.MM-<label>' in local time.
 */
export function folderName(session, date) {
  const d = new Date(date ?? session.startedAt);
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${mm}-${dd}-${hh}.${mi}-${slugLabel(session)}`;
}

// --------------------------------------------------------- line builders --

function describeStep(evt, esc = plain) {
  const label = esc(evt.label);
  const selector = esc(evt.selector);
  const value = evt.value !== undefined ? ` "${esc(evt.value)}"` : '';
  switch (evt.action) {
    case 'click':
      return `Click ${label} (${selector})`;
    case 'input':
    case 'change':
      return `Type${value} into ${label} (${selector})`;
    case 'submit':
      return `Submit ${label} (${selector})`;
    case 'key':
      return `Press${value} (${label}) (${selector})`;
    default:
      return `${evt.action} ${label} (${selector})`;
  }
}

function describeNav(evt, esc = plain) {
  return `Navigate to ${esc(evt.to)}`;
}

function formatConsoleLine(e, startedAt, esc = plain) {
  const stack = e.stack ? `\n${esc(e.stack)}` : '';
  return `${formatTs(e.ts, startedAt)} [${esc(e.level)}] ${esc(e.text)}${stack}`;
}

function formatNetworkLine(e, startedAt, esc = plain) {
  const mark = e.failed ? 'FAIL' : 'OK';
  const status = e.status ?? '-';
  const duration = e.durationMs ?? '-';
  const errPart = e.error ? ` error=${esc(e.error)}` : '';
  return `${formatTs(e.ts, startedAt)} [${mark}] ${esc(e.method)} ${esc(e.url)} status=${status} duration=${duration}ms${errPart}`;
}

function describeEvent(evt, startedAt, esc = plain) {
  const ts = formatTs(evt.ts, startedAt);
  switch (evt.kind) {
    case 'console':
      return formatConsoleLine(evt, startedAt, esc);
    case 'network':
      return formatNetworkLine(evt, startedAt, esc);
    case 'step':
      return `${ts} ${describeStep(evt, esc)}`;
    case 'nav':
      return `${ts} ${describeNav(evt, esc)}`;
    case 'annotation':
      return `${ts} Annotation #${evt.index}: ${esc(evt.note)}`;
    default:
      return `${ts} [${evt.kind}]`;
  }
}

function reproSteps(session, esc = plain) {
  return sortedEvents(session)
    .filter((e) => e.kind === 'step' || e.kind === 'nav')
    .map((e) => (e.kind === 'nav' ? describeNav(e, esc) : describeStep(e, esc)));
}

/** Up to CONTEXT_EVENTS events immediately before/after an annotation's marker. */
function timelineContext(sorted, annotationIndex) {
  const pos = sorted.findIndex((e) => e.kind === 'annotation' && e.index === annotationIndex);
  if (pos === -1) return [];
  const before = sorted.slice(Math.max(0, pos - CONTEXT_EVENTS), pos);
  const after = sorted.slice(pos + 1, pos + 1 + CONTEXT_EVENTS);
  return [...before, ...after];
}

// ------------------------------------------------------------- renderers --

/** annotations.txt */
export function renderAnnotations(session) {
  const annotations = session.annotations ?? [];
  if (annotations.length === 0) return 'No annotations recorded.\n';
  const blocks = annotations.map((a) =>
    [
      `[${a.index}] ${plain(a.note)}`,
      `selector: ${plain(a.selector)}`,
      `xpath: ${plain(a.xpath)}`,
      `label: ${plain(a.label)}`,
      `url: ${plain(a.url)}`,
      `ts: ${formatDateTime(a.ts)}`,
    ].join('\n'),
  );
  return `${blocks.join('\n\n')}\n`;
}

/** console.txt */
export function renderConsole(session) {
  const lines = consoleTimeline(session).map((e) => formatConsoleLine(e, session.startedAt));
  if (lines.length === 0) return 'No console output recorded.\n';
  return `${lines.join('\n')}\n`;
}

/** network.txt */
export function renderNetwork(session) {
  const lines = networkTimeline(session).map((e) => formatNetworkLine(e, session.startedAt));
  if (lines.length === 0) return 'No network activity recorded.\n';
  return `${lines.join('\n')}\n`;
}

/** e2e-helper.txt */
export function renderE2EHelper(session) {
  const steps = reproSteps(session);
  if (steps.length === 0) return 'No repro steps recorded.\n';
  return `${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
}

/** system-info.txt */
export function renderSystemInfo(session) {
  const sys = session.system ?? {};
  const counts = eventCounts(session);
  const lines = [
    `capturedAt: ${sys.capturedAt ?? ''}`,
    `startUrl: ${sys.startUrl ?? session.startUrl ?? ''}`,
    `userAgent: ${sys.userAgent ?? ''}`,
    `platform: ${sys.platform ?? ''}`,
    `language: ${sys.language ?? ''}`,
    `viewport: ${sys.viewport ? `${sys.viewport.width}x${sys.viewport.height}` : ''}`,
    `screen: ${sys.screen ? `${sys.screen.width}x${sys.screen.height}` : ''}`,
    `devicePixelRatio: ${sys.devicePixelRatio ?? ''}`,
    `extensionVersion: ${sys.extensionVersion ?? ''}`,
    `chromeVersion: ${sys.chromeVersion ?? ''}`,
    `timezone: ${sys.timezone ?? ''}`,
    '',
    `totalEvents: ${counts.total}`,
    `consoleEvents: ${counts.console}`,
    `networkEvents: ${counts.network}`,
    `stepEvents: ${counts.step}`,
    `navEvents: ${counts.nav}`,
    `annotationCount: ${session.annotations?.length ?? 0}`,
    `droppedOldestEvents: ${session.droppedOldestEvents ?? 0}`,
  ];
  return `${stripControl(lines.join('\n'))}\n`;
}

function playwrightStepLines(evt) {
  const selector = escapeJsString(evt.selector);
  switch (evt.action) {
    case 'click':
      return [`  await page.locator('${selector}').click();`];
    case 'input':
    case 'change':
      return [`  await page.locator('${selector}').fill('${escapeJsString(evt.value ?? '')}');`];
    case 'submit':
      return [`  await page.locator('${selector}').click(); // submit`];
    case 'key':
      return [`  await page.keyboard.press('${escapeJsString(evt.value ?? '')}');`];
    default:
      return [`  // unhandled step action: ${evt.action}`];
  }
}

function playwrightAnnotationLines(evt) {
  const selector = escapeJsString(evt.selector);
  const note = String(evt.note).replace(/\r?\n/g, ' ');
  return [`  // BUG: ${note}`, `  // expect(page.locator('${selector}')).toBeVisible();`];
}

/** e2e.spec.ts — runnable-looking Playwright skeleton. */
export function renderPlaywrightSpec(session) {
  const testName = escapeJsString(slugLabel(session));
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test('${testName}', async ({ page }) => {`,
    `  await page.goto('${escapeJsString(session.startUrl ?? '')}');`,
  ];
  for (const evt of sortedEvents(session)) {
    if (evt.kind === 'step') lines.push(...playwrightStepLines(evt));
    else if (evt.kind === 'nav') lines.push(`  await page.waitForURL('${escapeJsString(evt.to)}');`);
    else if (evt.kind === 'annotation') lines.push(...playwrightAnnotationLines(evt));
  }
  lines.push('});', '');
  return lines.join('\n');
}

function reportHeader(session) {
  const counts = eventCounts(session);
  const errors = consoleTimeline(session).filter((e) => e.level === 'error').length;
  const failures = networkTimeline(session).filter((e) => e.failed).length;
  return [
    `- **URL:** ${escapeMd(session.startUrl ?? '')}`,
    `- **Started:** ${formatDateTime(session.startedAt)}`,
    `- **Stopped:** ${session.stoppedAt ? formatDateTime(session.stoppedAt) : 'in progress'}`,
    `- **Annotations:** ${session.annotations?.length ?? 0}`,
    `- **Events:** ${counts.total} (console: ${counts.console}, network: ${counts.network}, step: ${counts.step}, nav: ${counts.nav})`,
    `- **Console errors:** ${errors}`,
    `- **Network failures:** ${failures}`,
  ];
}

function reportAnnotationBlock(a, sorted, startedAt) {
  const lines = [
    `## ${a.index}. ${escapeMd(a.note)}`,
    '',
    `- element: ${escapeMd(a.label)} (\`${escapeMd(a.selector)}\`)`,
    `- xpath: \`${escapeMd(a.xpath)}\``,
    `- url: ${escapeMd(a.url)}`,
  ];
  if (a.shots?.element) lines.push(`- element shot: ![element](${a.shots.element})`);
  if (a.shots?.full) lines.push(`- full shot: ![full](${a.shots.full})`);
  lines.push('', 'Nearby events:', '');
  const context = timelineContext(sorted, a.index);
  if (context.length === 0) lines.push('_None._');
  else context.forEach((evt) => lines.push(`- ${describeEvent(evt, startedAt, escapeMd)}`));
  lines.push('');
  return lines;
}

function reportAnnotations(session, sorted) {
  const annotations = session.annotations ?? [];
  if (annotations.length === 0) return ['_No annotations recorded._', ''];
  return annotations.flatMap((a) => reportAnnotationBlock(a, sorted, session.startedAt));
}

function reportRepro(session) {
  const steps = reproSteps(session, escapeMd);
  if (steps.length === 0) return ['_No repro steps recorded._', ''];
  return [...steps.map((s, i) => `${i + 1}. ${s}`), ''];
}

function reportCodeBlock(lines) {
  if (lines.length === 0) return ['_None._', ''];
  return ['```', ...lines, '```', ''];
}

/** report.md — full merged report: annotations inline, then timelines. */
export function renderReport(session) {
  const label = slugLabel(session);
  const sorted = sortedEvents(session);
  const parts = [
    `# BugPin Report — ${label}`,
    '',
    ...reportHeader(session),
    '',
    '## Annotations',
    '',
    ...reportAnnotations(session, sorted),
    '## Repro steps',
    '',
    ...reportRepro(session),
    '## Console (errors first, then everything)',
    '',
    ...reportCodeBlock(consoleTimeline(session).map((e) => formatConsoleLine(e, session.startedAt, escapeMd))),
    '## Network (failures first)',
    '',
    ...reportCodeBlock(networkTimeline(session).map((e) => formatNetworkLine(e, session.startedAt, escapeMd))),
    '## System info',
    '',
    ...reportCodeBlock(renderSystemInfo(session).trimEnd().split('\n')),
  ];
  return `${parts.join('\n')}\n`;
}

/**
 * @param {import('./capture-store.js').Session} session
 * @returns {{ folder: string, files: { path: string, content: string }[] }}
 *   Every text file in PROTOCOL.md §4 except the shots/ binaries, which the
 *   caller attaches separately.
 */
export function buildExport(session) {
  return {
    folder: folderName(session),
    files: [
      { path: 'report.md', content: renderReport(session) },
      { path: 'annotations.txt', content: renderAnnotations(session) },
      { path: 'console.txt', content: renderConsole(session) },
      { path: 'network.txt', content: renderNetwork(session) },
      { path: 'e2e-helper.txt', content: renderE2EHelper(session) },
      { path: 'e2e.spec.ts', content: renderPlaywrightSpec(session) },
      { path: 'system-info.txt', content: renderSystemInfo(session) },
      { path: 'session.json', content: `${JSON.stringify(session, null, 2)}\n` },
    ],
  };
}
