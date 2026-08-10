/**
 * chrome.webRequest / chrome.webNavigation -> PROTOCOL `network` and `nav`
 * Events, filtered to a single bound tab. Stateless w.r.t. persistence —
 * every observed event is handed to `onEvent`, which owns storage.
 */

import { redactUrl } from './redact.js';

const IN_FLIGHT_TTL_MS = 60_000;

/**
 * @param {{ onEvent: (event: object) => void, getTabId: () => number|null,
 *   getOptions: () => { redact: boolean } }} deps
 * @returns {{ attach: () => void, detach: () => void }}
 */
export function createNetworkCapture({ onEvent, getTabId, getOptions }) {
  const inFlight = new Map(); // requestId -> { method, resourceType, startedAt }
  let lastUrlByTab = new Map(); // tabId -> last committed url
  let attached = false;

  function sweepInFlight(now) {
    for (const [id, entry] of inFlight) {
      if (now - entry.startedAt > IN_FLIGHT_TTL_MS) inFlight.delete(id);
    }
  }

  // redactUrl(url, enabled) is a no-op unless `enabled` is passed truthy.
  function maybeRedact(url) {
    return redactUrl(url, Boolean(getOptions().redact));
  }

  function onBeforeRequest(details) {
    if (details.tabId !== getTabId()) return;
    const now = Date.now();
    sweepInFlight(now);
    inFlight.set(details.requestId, {
      method: details.method,
      resourceType: details.type,
      startedAt: now,
    });
  }

  function finish(details, { failed, error }) {
    if (details.tabId !== getTabId()) return;
    const start = inFlight.get(details.requestId);
    inFlight.delete(details.requestId);
    const now = Date.now();
    onEvent({
      id: crypto.randomUUID(),
      ts: now,
      kind: 'network',
      method: start?.method ?? details.method,
      url: maybeRedact(details.url),
      status: typeof details.statusCode === 'number' ? details.statusCode : null,
      statusText: details.statusLine || undefined,
      resourceType: start?.resourceType ?? details.type,
      durationMs: start ? now - start.startedAt : null,
      failed,
      error: error || undefined,
      fromCache: details.fromCache ?? undefined,
    });
  }

  function onCompleted(details) {
    finish(details, { failed: false, error: undefined });
  }

  function onErrorOccurred(details) {
    finish(details, { failed: true, error: details.error });
  }

  function onNavCommitted(details) {
    const tabId = getTabId();
    if (details.tabId !== tabId || details.frameId !== 0) return;
    const from = lastUrlByTab.get(tabId) ?? '';
    lastUrlByTab.set(tabId, details.url);
    onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: 'nav',
      from: maybeRedact(from),
      to: maybeRedact(details.url),
      transition: details.transitionType,
    });
  }

  function attach() {
    if (attached) return;
    attached = true;
    lastUrlByTab = new Map();
    inFlight.clear();
    const tabId = getTabId();
    const filter = tabId == null ? { urls: ['<all_urls>'] } : { urls: ['<all_urls>'], tabId };
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
    chrome.webRequest.onCompleted.addListener(onCompleted, filter);
    chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);
    chrome.webNavigation.onCommitted.addListener(onNavCommitted);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    chrome.webRequest.onCompleted.removeListener(onCompleted);
    chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
    chrome.webNavigation.onCommitted.removeListener(onNavCommitted);
    inFlight.clear();
  }

  return { attach, detach };
}
