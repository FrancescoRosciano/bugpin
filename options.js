/**
 * BugPin options page. Persists Options (PROTOCOL.md §6) to
 * chrome.storage.local under STORAGE.OPTIONS.
 */
import { STORAGE, DEFAULT_OPTIONS } from './lib/messages.js';

const SAVED_MS = 2000;

let savedTimeoutId = null;
const els = {};

function cacheEls() {
  els.screenshots = document.getElementById('screenshots');
  els.fullPageShot = document.getElementById('fullPageShot');
  els.redact = document.getElementById('redact');
  els.maxEvents = document.getElementById('maxEvents');
  els.copyPathOnExport = document.getElementById('copyPathOnExport');
  els.saveBtn = document.getElementById('saveBtn');
  els.resetBtn = document.getElementById('resetBtn');
  els.saved = document.getElementById('saved');
  els.error = document.getElementById('error');
}

function optionsFromForm() {
  const raw = Number(els.maxEvents.value);
  const maxEvents = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_OPTIONS.maxEvents;
  return {
    screenshots: els.screenshots.checked,
    fullPageShot: els.fullPageShot.checked,
    redact: els.redact.checked,
    maxEvents,
    copyPathOnExport: els.copyPathOnExport.checked,
  };
}

function applyToForm(options) {
  els.screenshots.checked = options.screenshots;
  els.fullPageShot.checked = options.fullPageShot;
  els.redact.checked = options.redact;
  els.maxEvents.value = String(options.maxEvents);
  els.copyPathOnExport.checked = options.copyPathOnExport;
}

function showSaved() {
  els.saved.hidden = false;
  clearTimeout(savedTimeoutId);
  savedTimeoutId = setTimeout(() => {
    els.saved.hidden = true;
  }, SAVED_MS);
}

function showError(message) {
  els.error.textContent = message || '';
}

async function loadOptions() {
  try {
    const stored = await chrome.storage.local.get(STORAGE.OPTIONS);
    const options = { ...DEFAULT_OPTIONS, ...(stored[STORAGE.OPTIONS] || {}) };
    applyToForm(options);
  } catch (err) {
    showError(err.message);
  }
}

async function persist(options) {
  await chrome.storage.local.set({ [STORAGE.OPTIONS]: options });
  showSaved();
  showError('');
}

async function handleSave() {
  try {
    await persist(optionsFromForm());
  } catch (err) {
    showError(err.message);
  }
}

async function handleReset() {
  try {
    applyToForm(DEFAULT_OPTIONS);
    await persist({ ...DEFAULT_OPTIONS });
  } catch (err) {
    showError(err.message);
  }
}

function init() {
  cacheEls();
  els.saveBtn.addEventListener('click', handleSave);
  els.resetBtn.addEventListener('click', handleReset);
  loadOptions();
}

document.addEventListener('DOMContentLoaded', init);
