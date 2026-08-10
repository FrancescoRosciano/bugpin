// Force a fixed timezone so local-time formatting is deterministic across
// machines/CI. Safe here because lib/export.js never touches Date at
// module-load time — only inside the functions under test below.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugLabel,
  folderName,
  renderReport,
  renderAnnotations,
  renderConsole,
  renderNetwork,
  renderE2EHelper,
  renderSystemInfo,
  renderPlaywrightSpec,
  buildExport,
} from '../lib/export.js';

const STARTED_AT = Date.UTC(2024, 2, 15, 10, 0, 0); // 2024-03-15T10:00:00.000Z

function emptySession(overrides = {}) {
  return {
    id: `${STARTED_AT}-abc123`,
    tabId: 1,
    startedAt: STARTED_AT,
    stoppedAt: null,
    startUrl: 'https://example.com/app',
    annotating: false,
    events: [],
    annotations: [],
    droppedOldestEvents: 0,
    system: {
      capturedAt: '2024-03-15T10:00:00.000Z',
      startUrl: 'https://example.com/app',
      userAgent: 'TestAgent/1.0',
      platform: 'MacIntel',
      language: 'en-US',
      viewport: { width: 1280, height: 800 },
      screen: { width: 1440, height: 900 },
      devicePixelRatio: 2,
      extensionVersion: '0.1.0',
      chromeVersion: '120.0.0.0',
      timezone: 'UTC',
    },
    ...overrides,
  };
}

function fullSessionFixture() {
  const t0 = STARTED_AT;
  const events = [
    { id: 'e1', ts: t0 + 100, kind: 'nav', from: '', to: 'https://example.com/app', transition: 'typed' },
    { id: 'e2', ts: t0 + 200, kind: 'console', level: 'info', text: 'app booted', url: 'https://example.com/app' },
    {
      id: 'e3',
      ts: t0 + 300,
      kind: 'step',
      action: 'click',
      selector: '#submit',
      xpath: '//*[@id="submit"]',
      label: 'Submit button',
      url: 'https://example.com/app',
    },
    {
      id: 'e4',
      ts: t0 + 400,
      kind: 'step',
      action: 'input',
      selector: 'input[name="q"]',
      xpath: '//input[@name="q"]',
      label: 'Search input',
      value: 'hello "world"',
      url: 'https://example.com/app',
    },
    {
      id: 'e5',
      ts: t0 + 500,
      kind: 'console',
      level: 'error',
      text: 'TypeError: x is not a function',
      stack: 'at foo (app.js:1:1)',
      url: 'https://example.com/app',
    },
    {
      id: 'e6',
      ts: t0 + 600,
      kind: 'network',
      method: 'GET',
      url: 'https://api.example.com/data',
      status: 500,
      statusText: 'Internal Server Error',
      resourceType: 'xhr',
      durationMs: 120,
      failed: true,
      error: 'net::ERR_FAILED',
    },
    {
      id: 'e7',
      ts: t0 + 650,
      kind: 'network',
      method: 'GET',
      url: 'https://api.example.com/ok',
      status: 200,
      resourceType: 'xhr',
      durationMs: 50,
      failed: false,
    },
    { id: 'e8', ts: t0 + 700, kind: 'annotation', index: 1, note: 'Button `misaligned` | broken', selector: '#submit' },
  ];
  const annotations = [
    {
      note: 'Button `misaligned` | broken',
      selector: '#submit',
      xpath: '//*[@id="submit"]',
      label: 'Submit button',
      tagName: 'BUTTON',
      attrs: { id: 'submit' },
      text: 'Submit',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      devicePixelRatio: 2,
      url: 'https://example.com/app',
      ts: t0 + 700,
      index: 1,
      shots: { full: 'shots/01-full.jpg', element: 'shots/01-element.jpg' },
    },
  ];
  return emptySession({ events, annotations, stoppedAt: t0 + 1000 });
}

// ---------------------------------------------------------------- slugLabel

test('slugLabel: falls back to "session" for a fully empty session', () => {
  assert.equal(slugLabel(emptySession()), 'session');
});

test('slugLabel: uses the first annotation note when present', () => {
  const session = emptySession({
    annotations: [{ note: 'Login button is broken!!', index: 1 }],
  });
  assert.equal(slugLabel(session), 'login-button-is-broken');
});

test('slugLabel: falls back to the last console error text when no annotations', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: 1, kind: 'console', level: 'error', text: 'first error', url: '' },
      { id: 'e2', ts: 2, kind: 'console', level: 'log', text: 'not an error', url: '' },
      { id: 'e3', ts: 3, kind: 'console', level: 'error', text: 'Second Error!', url: '' },
    ],
  });
  assert.equal(slugLabel(session), 'second-error');
});

test('slugLabel: ignores non-error console lines entirely when picking fallback', () => {
  const session = emptySession({
    events: [{ id: 'e1', ts: 1, kind: 'console', level: 'log', text: 'just a log line', url: '' }],
  });
  assert.equal(slugLabel(session), 'session');
});

test('slugLabel: emoji-only note slugifies to nothing and falls back to "session"', () => {
  const session = emptySession({ annotations: [{ note: '🐛🔥💥', index: 1 }] });
  assert.equal(slugLabel(session), 'session');
});

test('slugLabel: note that collapses entirely to punctuation falls back to "session"', () => {
  const session = emptySession({ annotations: [{ note: '!!! --- ???', index: 1 }] });
  assert.equal(slugLabel(session), 'session');
});

test('slugLabel: a 100-char note is capped at 40 chars with no trailing dash', () => {
  const note = 'a'.repeat(100);
  const session = emptySession({ annotations: [{ note, index: 1 }] });
  const label = slugLabel(session);
  assert.equal(label.length, 40);
  assert.equal(label, 'a'.repeat(40));
});

test('slugLabel: collapses repeated separators and trims edges', () => {
  const session = emptySession({ annotations: [{ note: '  --Weird___Note!!--  ', index: 1 }] });
  assert.equal(slugLabel(session), 'weird-note');
});

// -------------------------------------------------------------- folderName

test('folderName: zero-padded MM-DD-HH.MM-<label> in local (UTC) time', () => {
  const session = emptySession({ annotations: [{ note: 'Delete this', index: 1 }] });
  assert.equal(folderName(session), '03-15-10.00-delete-this');
});

test('folderName: accepts an explicit date overriding session.startedAt', () => {
  const session = emptySession();
  const explicit = Date.UTC(2024, 0, 5, 3, 7, 0);
  assert.equal(folderName(session, explicit), '01-05-03.07-session');
});

// --------------------------------------------------------- render* basics

test('renderAnnotations: empty session says so', () => {
  assert.equal(renderAnnotations(emptySession()), 'No annotations recorded.\n');
});

test('renderConsole: empty session says so', () => {
  assert.equal(renderConsole(emptySession()), 'No console output recorded.\n');
});

test('renderNetwork: empty session says so', () => {
  assert.equal(renderNetwork(emptySession()), 'No network activity recorded.\n');
});

test('renderE2EHelper: empty session says so', () => {
  assert.equal(renderE2EHelper(emptySession()), 'No repro steps recorded.\n');
});

test('renderConsole: session with only console errors renders both lines', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: STARTED_AT + 10, kind: 'console', level: 'error', text: 'boom one', url: '' },
      { id: 'e2', ts: STARTED_AT + 20, kind: 'console', level: 'error', text: 'boom two', url: '' },
    ],
  });
  const out = renderConsole(session);
  assert.match(out, /boom one/);
  assert.match(out, /boom two/);
  assert.equal(out.trim().split('\n').length, 2);
});

test('renderConsole: errors sort before non-errors, chronological order kept within each group', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: 1, kind: 'console', level: 'log', text: 'a-log', url: '' },
      { id: 'e2', ts: 2, kind: 'console', level: 'error', text: 'b-error', url: '' },
      { id: 'e3', ts: 3, kind: 'console', level: 'log', text: 'c-log', url: '' },
      { id: 'e4', ts: 4, kind: 'console', level: 'error', text: 'd-error', url: '' },
    ],
  });
  const lines = renderConsole(session).trim().split('\n');
  assert.match(lines[0], /b-error/);
  assert.match(lines[1], /d-error/);
  assert.match(lines[2], /a-log/);
  assert.match(lines[3], /c-log/);
});

test('renderNetwork: failures sort before successes', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: 1, kind: 'network', method: 'GET', url: 'https://x/ok', status: 200, resourceType: 'xhr', durationMs: 1, failed: false },
      { id: 'e2', ts: 2, kind: 'network', method: 'GET', url: 'https://x/fail', status: 500, resourceType: 'xhr', durationMs: 1, failed: true },
    ],
  });
  const lines = renderNetwork(session).trim().split('\n');
  assert.match(lines[0], /FAIL/);
  assert.match(lines[0], /\/fail/);
  assert.match(lines[1], /OK/);
});

test('renderE2EHelper: numbers click/type/nav steps in chronological order', () => {
  const session = fullSessionFixture();
  const out = renderE2EHelper(session);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1\. Navigate to https:\/\/example\.com\/app$/);
  assert.match(lines[1], /^2\. Click Submit button \(#submit\)$/);
  assert.match(lines[2], /^3\. Type "hello "world"" into Search input \(input\[name="q"\]\)$/);
});

test('renderSystemInfo: includes event counts and droppedOldestEvents', () => {
  const session = fullSessionFixture();
  const out = renderSystemInfo(session);
  assert.match(out, /totalEvents: 8/);
  assert.match(out, /consoleEvents: 2/);
  assert.match(out, /networkEvents: 2/);
  assert.match(out, /stepEvents: 2/);
  assert.match(out, /navEvents: 1/);
  assert.match(out, /annotationCount: 1/);
  assert.match(out, /droppedOldestEvents: 0/);
  assert.match(out, /userAgent: TestAgent\/1\.0/);
});

test('renderAnnotations: one block per annotation with index/note/selector/xpath/label/url/ts', () => {
  const session = fullSessionFixture();
  const out = renderAnnotations(session);
  assert.match(out, /^\[1\] Button `misaligned` \| broken$/m);
  assert.match(out, /^selector: #submit$/m);
  assert.match(out, /^xpath: \/\/\*\[@id="submit"\]$/m);
  assert.match(out, /^label: Submit button$/m);
  assert.match(out, /^url: https:\/\/example\.com\/app$/m);
});

// ------------------------------------------------------------- renderReport

test('renderReport: empty session produces a readable, non-crashing report', () => {
  const out = renderReport(emptySession());
  assert.match(out, /^# BugPin Report — session/);
  assert.match(out, /\*\*URL:\*\* https:\/\/example\.com\/app/);
  assert.match(out, /## Annotations/);
  assert.match(out, /_No annotations recorded\._/);
  assert.match(out, /## Repro steps/);
  assert.match(out, /_No repro steps recorded\._/);
  assert.match(out, /## Console \(errors first, then everything\)/);
  assert.match(out, /## Network \(failures first\)/);
  assert.match(out, /## System info/);
});

test('renderReport: escapes backticks and pipes from captured strings', () => {
  const out = renderReport(fullSessionFixture());
  // The raw note contains a literal backtick and pipe; both must be escaped.
  assert.doesNotMatch(out, /## 1\. Button `misaligned` \| broken/);
  assert.match(out, /## 1\. Button \\`misaligned\\` \\\|broken|## 1\. Button \\`misaligned\\` \\\| broken/);
});

test('renderReport: each annotation section is headed "### N. <note>" and links shots', () => {
  const out = renderReport(fullSessionFixture());
  // h3, so each note nests under the "## Annotations" section rather than
  // becoming a sibling of it in a table of contents.
  assert.match(out, /^### 1\. /m);
  assert.doesNotMatch(out, /^## 1\. /m);
  assert.match(out, /shots\/01-element\.jpg/);
  assert.match(out, /shots\/01-full\.jpg/);
});

test('renderPlaywrightSpec: a redacted value becomes an env placeholder, not a literal', () => {
  const session = fullSessionFixture();
  const step = session.events.find((e) => e.kind === 'step' && e.action === 'input');
  step.value = '«redacted»';
  const out = renderPlaywrightSpec(session);
  // Filling the literal placeholder would type "«redacted»" into the field.
  assert.doesNotMatch(out, /fill\('«redacted»'\)/);
  assert.match(out, /process\.env\.BUGPIN_SECRET \?\? ''/);
  assert.match(out, /TODO: the real value was redacted/);
});

test('renderReport: annotation block includes nearby timeline context', () => {
  const out = renderReport(fullSessionFixture());
  assert.match(out, /Nearby events:/);
  // Event e3 (click) and e5 (console error) are within 3 slots of the marker.
  assert.match(out, /Click Submit button/);
});

test('renderReport is deterministic given a fixed session fixture', () => {
  const a = renderReport(fullSessionFixture());
  const b = renderReport(fullSessionFixture());
  assert.equal(a, b);
});

// --------------------------------------------------------- Playwright spec

test('renderPlaywrightSpec: produces a named test with goto + one line per step', () => {
  const session = fullSessionFixture();
  const out = renderPlaywrightSpec(session);
  assert.match(out, /^import \{ test, expect \} from '@playwright\/test';$/m);
  assert.match(out, /^test\('button-misaligned-broken', async \(\{ page \}\) => \{$/m);
  assert.match(out, /await page\.goto\('https:\/\/example\.com\/app'\);/);
  assert.match(out, /await page\.locator\('#submit'\)\.click\(\);/);
  // Destination is a single-quoted JS string, so embedded double quotes need
  // no escaping at all.
  assert.match(out, /await page\.locator\('input\[name="q"\]'\)\.fill\('hello "world"'\);/);
  assert.match(out, /\/\/ BUG: Button `misaligned` \| broken/);
  assert.match(out, /\/\/ expect\(page\.locator\('#submit'\)\)\.toBeVisible\(\);/);
});

test('renderPlaywrightSpec: escapes quotes and backslashes in selectors/values', () => {
  // Raw selector contains one backslash and one apostrophe; raw value
  // contains two backslashes and three apostrophes. Backslashes must double
  // and apostrophes must gain a leading backslash so the emitted single-
  // quoted TS string literal stays syntactically valid.
  const session = emptySession({
    events: [
      {
        id: 'e1',
        ts: STARTED_AT + 10,
        kind: 'step',
        action: 'input',
        selector: 'input[data-x="a\\b\'c"]',
        xpath: '',
        label: 'weird input',
        value: "it's a \\backslash\\ and 'quotes'",
        url: '',
      },
    ],
  });
  const out = renderPlaywrightSpec(session);
  assert.match(out, /\.locator\('input\[data-x="a\\\\b\\'c"\]'\)/);
  assert.match(out, /\.fill\('it\\'s a \\\\backslash\\\\ and \\'quotes\\''\);/);
});

test('renderPlaywrightSpec: maps nav events to waitForURL and key events to keyboard.press', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: STARTED_AT + 10, kind: 'nav', from: '', to: 'https://example.com/next', transition: 'link' },
      { id: 'e2', ts: STARTED_AT + 20, kind: 'step', action: 'key', selector: 'body', xpath: '', label: 'body', value: 'Enter', url: '' },
    ],
  });
  const out = renderPlaywrightSpec(session);
  assert.match(out, /await page\.waitForURL\('https:\/\/example\.com\/next'\);/);
  assert.match(out, /await page\.keyboard\.press\('Enter'\);/);
});

// ------------------------------------------------------------- buildExport

test('buildExport: returns folder + every text file from PROTOCOL.md §4', () => {
  const session = fullSessionFixture();
  const result = buildExport(session);
  assert.equal(result.folder, '03-15-10.00-button-misaligned-broken');
  const paths = result.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'annotations.txt',
    'console.txt',
    'e2e-helper.txt',
    'e2e.spec.ts',
    'network.txt',
    'report.md',
    'session.json',
    'system-info.txt',
  ]);
  for (const file of result.files) {
    assert.equal(typeof file.content, 'string');
    assert.ok(file.content.length > 0);
  }
});

test('buildExport: session.json round-trips the full serialized session', () => {
  const session = fullSessionFixture();
  const result = buildExport(session);
  const jsonFile = result.files.find((f) => f.path === 'session.json');
  assert.deepEqual(JSON.parse(jsonFile.content), session);
});

test('buildExport is deterministic given a fixed session fixture', () => {
  const a = buildExport(fullSessionFixture());
  const b = buildExport(fullSessionFixture());
  assert.deepEqual(a, b);
});

// ------------------------------------------------- control-char sanitising

const ESC = '\u001b';

test('renderConsole strips terminal escape sequences from page-controlled text', () => {
  const session = emptySession({
    events: [
      {
        id: 'e1',
        ts: STARTED_AT + 10,
        kind: 'console',
        level: 'error',
        text: `${ESC}[31mfake red${ESC}[0m and ${ESC}]0;retitled\u0007`,
        stack: `at evil${ESC}[2Koverwrite`,
        url: '',
      },
    ],
  });
  const out = renderConsole(session);
  assert.doesNotMatch(out, /\u001b/);
  assert.doesNotMatch(out, /\u0007/);
  // The readable payload survives — only the control bytes go.
  assert.match(out, /\[31mfake red/);
  assert.match(out, /at evil\[2Koverwrite/);
});

test('renderConsole strips CR so a line cannot overwrite the previous one', () => {
  const session = emptySession({
    events: [{ id: 'e1', ts: STARTED_AT + 10, kind: 'console', level: 'log', text: 'visible\rHIDDEN', url: '' }],
  });
  const out = renderConsole(session);
  assert.doesNotMatch(out, /\r/);
  assert.match(out, /visibleHIDDEN/);
});

test('renderNetwork and renderAnnotations strip control characters too', () => {
  const session = emptySession({
    events: [
      {
        id: 'e1', ts: STARTED_AT + 10, kind: 'network', method: 'GET',
        url: `https://x/a${ESC}[1m`, status: 200, resourceType: 'xhr',
        durationMs: 1, failed: false,
      },
    ],
    annotations: [
      {
        note: `broken${ESC}[31m`, selector: '#a', xpath: '//a', label: `lbl${ESC}[0m`,
        tagName: 'A', attrs: {}, text: '', rect: { x: 0, y: 0, width: 1, height: 1 },
        devicePixelRatio: 1, url: `https://x/b `, ts: STARTED_AT + 10,
        index: 1, shots: { full: null, element: null },
      },
    ],
  });
  assert.doesNotMatch(renderNetwork(session), /\u001b/);
  assert.doesNotMatch(renderAnnotations(session), /[\u001b ]/);
  assert.doesNotMatch(renderReport(session), /\u001b/);
});

test('renderPlaywrightSpec strips control characters from selectors and values', () => {
  const session = emptySession({
    events: [
      {
        id: 'e1', ts: STARTED_AT + 10, kind: 'step', action: 'input',
        selector: `#q${ESC}[1m`, xpath: '', label: 'q', value: `typed ${ESC}]0;x\u0007`, url: '',
      },
    ],
  });
  const out = renderPlaywrightSpec(session);
  assert.doesNotMatch(out, /[\u001b \u0007]/);
});

test('renderSystemInfo strips control characters from the user agent', () => {
  const session = emptySession();
  session.system = { ...session.system, userAgent: `Mozilla${ESC}[31m/5.0` };
  assert.doesNotMatch(renderSystemInfo(session), /\u001b/);
});

// --------------------------------------------- corrupt/missing timestamps

test('sorting survives events with a missing or non-numeric ts', () => {
  const session = emptySession({
    events: [
      { id: 'e1', ts: STARTED_AT + 20, kind: 'console', level: 'log', text: 'second', url: '' },
      { id: 'e2', kind: 'console', level: 'log', text: 'no-ts', url: '' },
      { id: 'e3', ts: STARTED_AT + 10, kind: 'console', level: 'log', text: 'first', url: '' },
    ],
  });
  const lines = renderConsole(session).trim().split('\n');
  // Deterministic order, and NEVER "Invalid Date" leaking into the report.
  assert.equal(lines.length, 3);
  assert.match(lines[0], /no-ts/);
  assert.match(lines[1], /first/);
  assert.match(lines[2], /second/);
  assert.doesNotMatch(renderConsole(session), /Invalid Date|NaN/);
});

test('renderReport and renderAnnotations never emit "Invalid Date" for a corrupt ts', () => {
  const session = emptySession({
    annotations: [
      {
        note: 'no timestamp', selector: '#a', xpath: '//a', label: 'a', tagName: 'A',
        attrs: {}, text: '', rect: { x: 0, y: 0, width: 1, height: 1 },
        devicePixelRatio: 1, url: 'https://x', index: 1, shots: { full: null, element: null },
      },
    ],
  });
  assert.doesNotMatch(renderAnnotations(session), /Invalid Date|NaN/);
  assert.doesNotMatch(renderReport(session), /Invalid Date|NaN/);
});

test('buildExport: does not mutate the input session', () => {
  const session = fullSessionFixture();
  const before = JSON.stringify(session);
  buildExport(session);
  assert.equal(JSON.stringify(session), before);
});
