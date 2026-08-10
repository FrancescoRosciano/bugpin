/**
 * Screenshot capture for annotations: a full visible-tab JPEG plus a
 * cropped element JPEG, both returned as data URLs. Never throws —
 * permission or rate-limit failures degrade to `null` fields so the
 * caller can still persist the annotation.
 */

import { LIMITS } from './messages.js';

const RATE_LIMIT_WINDOW_MS = 1100; // > 1s: chrome allows ~1 captureVisibleTab/sec

let lastCaptureAt = 0;
let captureQueue = Promise.resolve();

/** Serializes calls through a single queue so concurrent captures don't race the rate limit. */
function serializeCapture(fn) {
  const run = captureQueue.then(fn, fn);
  captureQueue = run.catch(() => {});
  return run;
}

async function callCaptureVisibleTab(windowId) {
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg',
    quality: Math.round(LIMITS.SHOT_QUALITY * 100),
  });
}

/**
 * captureVisibleTab shoots whatever is ACTIVE in the window, not a given tab —
 * and this capture may have been sitting behind up to RATE_LIMIT_WINDOW_MS of
 * throttling plus other queued captures. Re-checking immediately before every
 * shot is what stops an unrelated tab being embedded in the export as evidence.
 */
async function activeWindowIdFor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('bound tab is no longer the active tab');
  return tab.windowId;
}

async function throttledCaptureVisibleTab(tabId) {
  const wait = Math.max(0, RATE_LIMIT_WINDOW_MS - (Date.now() - lastCaptureAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  try {
    return await callCaptureVisibleTab(await activeWindowIdFor(tabId));
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) throw err;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
    return callCaptureVisibleTab(await activeWindowIdFor(tabId));
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** Scales a CSS-px rect to device px, pads it, and clamps to the bitmap bounds. */
function scaleAndClampRect(rect, dpr, pad, bounds) {
  const x = (rect.x - pad) * dpr;
  const y = (rect.y - pad) * dpr;
  const width = (rect.width + pad * 2) * dpr;
  const height = (rect.height + pad * 2) * dpr;
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(bounds.width, Math.round(x + width));
  const bottom = Math.min(bounds.height, Math.round(y + height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function cropElementShot(fullDataUrl, rect, dpr) {
  const sourceBlob = await (await fetch(fullDataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const crop = scaleAndClampRect(rect, dpr, LIMITS.ELEMENT_SHOT_PAD, {
    width: bitmap.width,
    height: bitmap.height,
  });
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: LIMITS.SHOT_QUALITY });
  return blobToDataUrl(blob);
}

/**
 * @param {{ tabId: number, annotation: { index: number, rect: object,
 *   devicePixelRatio: number }, options: { fullPageShot?: boolean } }} args
 * @returns {Promise<{ full: string|null, element: string|null }>}
 */
export async function captureAnnotationShots({ tabId, annotation, options }) {
  if ((annotation.index ?? 0) > LIMITS.MAX_SHOTS) return { full: null, element: null };
  let full = null;
  try {
    full = await serializeCapture(() => throttledCaptureVisibleTab(tabId));
  } catch (err) {
    console.error('[bugpin] visible-tab capture skipped/failed', err);
    return { full: null, element: null };
  }
  let element = null;
  try {
    element = await cropElementShot(full, annotation.rect, annotation.devicePixelRatio || 1);
  } catch (err) {
    console.error('[bugpin] element crop failed', err);
  }
  return { full: options?.fullPageShot === false ? null : full, element };
}
