/**
 * Frozen protocol constants shared by the service worker, content scripts,
 * popup and options page. See PROTOCOL.md — this file is the machine-readable
 * half of that contract. Never add a message type without updating PROTOCOL.md.
 */

export const MSG = Object.freeze({
  // MAIN world -> ISOLATED bridge, via window.postMessage
  MAIN_TO_BRIDGE: 'bugpin:main->bridge',

  // content -> service worker
  EVENT: 'bugpin:event',
  ANNOTATION: 'bugpin:annotation',
  STATE_REQUEST: 'bugpin:state?',

  // service worker -> content
  SET_MODE: 'bugpin:set-mode',
  RESTORE_PINS: 'bugpin:restore-pins',

  // popup / options -> service worker
  START: 'bugpin:start',
  STOP: 'bugpin:stop',
  TOGGLE_ANNOTATE: 'bugpin:toggle-annotate',
  EXPORT: 'bugpin:export',
  STATUS: 'bugpin:status',
  DISCARD: 'bugpin:discard',
});

export const STORAGE = Object.freeze({
  SESSION: 'bugpin.session',
  SHOT_PREFIX: 'bugpin.shot.',
  OPTIONS: 'bugpin.options',
});

export const LIMITS = Object.freeze({
  MAX_EVENTS: 5000,
  MAX_ANNOTATIONS: 50,
  MAX_SHOTS: 25,
  MAX_STRING: 4000,
  SHOT_QUALITY: 0.7,
  ELEMENT_SHOT_PAD: 8,
});

export const DEFAULT_OPTIONS = Object.freeze({
  screenshots: true,
  fullPageShot: true,
  redact: true,
  maxEvents: LIMITS.MAX_EVENTS,
  copyPathOnExport: true,
});

/** Attribute marking every DOM node the extension itself owns. */
export const UI_MARKER = 'data-bugpin-ui';
