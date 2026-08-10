/**
 * BugPin popup. Renders session status via MSG.STATUS and re-renders after
 * every action. No inline handlers (CSP), no alert() — errors render inline.
 */
import { MSG, STORAGE, DEFAULT_OPTIONS } from './lib/messages.js';

const POLL_MS = 1000;
const FOLDER_TRUNCATE_LEN = 44;

let pollId = null;
let currentState = null;
const els = {};

function cacheEls() {
  els.status = document.getElementById('status');
  els.statusDetail = document.getElementById('statusDetail');
  els.primary = document.getElementById('primaryBtn');
  els.annotate = document.getElementById('annotateBtn');
  els.exportBtn = document.getElementById('exportBtn');
  els.discardBtn = document.getElementById('discardBtn');
  els.optionsBtn = document.getElementById('optionsBtn');
  els.exportInfo = document.getElementById('exportInfo');
  els.error = document.getElementById('error');
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function truncateMiddle(str, max) {
  if (str.length <= max) return str;
  const half = Math.floor((max - 1) / 2);
  return `${str.slice(0, half)}…${str.slice(str.length - half)}`;
}

/** Headline word — the one thing worth reading at a glance. */
function statusText(state) {
  if (!state.recording) return 'Idle';
  return state.annotating ? 'Annotating' : 'Recording';
}

/** Supporting detail line; empty when there is nothing to say. */
function statusDetailText(state) {
  if (!state.recording) return 'Nothing is being captured yet.';
  const elapsed = state.startedAt ? formatDuration(Date.now() - state.startedAt) : '00:00';
  return `${state.eventCount} events · ${state.annotationCount} notes · ${elapsed}`;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function showError(message) {
  els.error.textContent = message || '';
}

function render(state) {
  currentState = state;
  els.status.textContent = statusText(state);
  els.statusDetail.textContent = statusDetailText(state);
  els.primary.textContent = state.recording ? 'Stop' : 'Start session';

  els.annotate.classList.toggle('active', Boolean(state.annotating));
  els.annotate.setAttribute('aria-pressed', String(Boolean(state.annotating)));

  const hasData = state.eventCount > 0 || state.annotationCount > 0;
  els.exportBtn.disabled = !hasData;
  els.exportBtn.title = hasData ? '' : 'Nothing captured yet';
  els.discardBtn.disabled = !hasData && !state.recording;
}

async function refresh() {
  try {
    const state = await sendMessage({ type: MSG.STATUS });
    render(state);
  } catch (err) {
    showError(err.message);
  }
}

async function handlePrimary() {
  try {
    const type = currentState && currentState.recording ? MSG.STOP : MSG.START;
    const state = await sendMessage({ type });
    render(state);
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function handleAnnotate() {
  try {
    const wantOn = !(currentState && currentState.annotating);
    const state = await sendMessage({ type: MSG.TOGGLE_ANNOTATE, on: wantOn });
    render(state);
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

/** The service worker has no clipboard, so the popup honours copyPathOnExport. */
async function shouldCopyPath() {
  try {
    const stored = await chrome.storage.local.get(STORAGE.OPTIONS);
    const options = { ...DEFAULT_OPTIONS, ...(stored[STORAGE.OPTIONS] || {}) };
    return Boolean(options.copyPathOnExport);
  } catch (_storageErr) {
    return DEFAULT_OPTIONS.copyPathOnExport;
  }
}

async function copyFolderPath(folder) {
  if (!(await shouldCopyPath())) return false;
  try {
    await navigator.clipboard.writeText(folder);
    return true;
  } catch (_clipboardErr) {
    return false;
  }
}

async function handleExport() {
  els.exportInfo.hidden = true;
  try {
    const result = await sendMessage({ type: MSG.EXPORT });
    if (!result || !result.ok) {
      showError((result && result.error) || 'Export failed.');
      return;
    }
    const copied = await copyFolderPath(result.folder);
    const note = copied ? ' (copied to clipboard)' : '';
    els.exportInfo.textContent = `Exported to ${truncateMiddle(result.folder, FOLDER_TRUNCATE_LEN)}${note}`;
    els.exportInfo.hidden = false;
    showError('');
    await refresh();
  } catch (err) {
    showError(err.message);
  }
}

async function handleDiscard() {
  try {
    const state = await sendMessage({ type: MSG.DISCARD });
    render(state);
    els.exportInfo.hidden = true;
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

function handleOptions() {
  chrome.runtime.openOptionsPage();
}

function init() {
  cacheEls();
  els.primary.addEventListener('click', handlePrimary);
  els.annotate.addEventListener('click', handleAnnotate);
  els.exportBtn.addEventListener('click', handleExport);
  els.discardBtn.addEventListener('click', handleDiscard);
  els.optionsBtn.addEventListener('click', handleOptions);

  refresh();
  pollId = setInterval(refresh, POLL_MS);
  window.addEventListener('unload', () => clearInterval(pollId));
}

document.addEventListener('DOMContentLoaded', init);
