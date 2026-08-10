/**
 * Pure, DOM-agnostic element description: stable CSS selector, absolute
 * XPath, and a human-readable label. Every function reads only standard DOM
 * properties (tagName, id, className/classList, attributes, parentElement,
 * children, getBoundingClientRect, textContent/innerText, ownerDocument) so
 * it can be driven by a hand-built fake element in tests. See PROTOCOL.md §1
 * and §3 (AnnotationIn) for the shapes this feeds.
 */

import { UI_MARKER } from './messages.js';

const REPLACEMENT_CHAR = '�';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORM_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const LABEL_MAX = 60;
const TEXT_MAX = 200;
const ATTR_KEYS = ['id', 'class', 'name', 'type', 'data-testid', 'aria-label', 'href'];

/** Reads an attribute via the NamedNodeMap-like `attributes` or plain fallbacks. */
function getAttr(el, name) {
  if (!el) return null;
  if (el.attributes) {
    if (typeof el.attributes.getNamedItem === 'function') {
      const node = el.attributes.getNamedItem(name);
      return node ? node.value : null;
    }
    if (Object.prototype.hasOwnProperty.call(el.attributes, name)) {
      const value = el.attributes[name];
      return value == null ? null : String(value);
    }
  }
  if (name === 'id' && el.id != null) return el.id;
  if ((name === 'class' || name === 'className') && el.className != null) return el.className;
  return null;
}

function hasUiMarker(node) {
  return getAttr(node, UI_MARKER) != null;
}

/** Local CSS.escape fallback (CSSOM serialization algorithm, simplified). */
function localCssEscape(value) {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (code === 0) {
      result += REPLACEMENT_CHAR;
      continue;
    }
    if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if ((i === 0 && code >= 0x30 && code <= 0x39) ||
        (i === 1 && code >= 0x30 && code <= 0x39 && value[0] === '-')) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && len1Dash(value)) {
      result += `\\${ch}`;
      continue;
    }
    if (isSafeCssChar(code)) {
      result += ch;
      continue;
    }
    result += `\\${ch}`;
  }
  return result;
}

function len1Dash(value) {
  return value.length === 1 && value === '-';
}

function isSafeCssChar(code) {
  return code >= 0x80 || code === 0x2d || code === 0x5f ||
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

export function escapeCSSValue(value) {
  const str = String(value ?? '');
  if (str === '') return str;
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
  return localCssEscape(str);
}

function isUnstableToken(token) {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
  if (UUID_RE.test(token)) return true;
  if (token.length >= 8 && /^[0-9a-f]+$/i.test(token) && /\d/.test(token)) return true;
  if (token.length >= 10 && /^[a-z0-9]+$/i.test(token) && /[a-z]/i.test(token) && /\d/.test(token)) return true;
  return false;
}

/** True when `id` is safe to key a selector on: no digit-only chunks, hashes, or UUIDs. */
export function isStableId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  const chunks = trimmed.split(/[-_]/).filter(Boolean);
  if (chunks.length === 0) return false;
  return !chunks.some(isUnstableToken);
}

function getClassTokens(node) {
  if (!node) return [];
  if (node.classList && typeof node.classList.length === 'number') {
    return Array.from(node.classList).filter(Boolean);
  }
  if (typeof node.className === 'string' && node.className.trim()) {
    return node.className.trim().split(/\s+/);
  }
  return [];
}

/** Stable dotted class chain for `node` (e.g. ".btn.primary"), or '' if none qualify. */
export function classChain(node) {
  const stable = getClassTokens(node).filter((token) => isStableId(token));
  if (stable.length === 0) return '';
  return stable.map((c) => `.${escapeCSSValue(c)}`).join('');
}

function stableSelectorFor(node) {
  if (!node || !node.tagName || hasUiMarker(node)) return null;
  const testId = getAttr(node, 'data-testid') ?? getAttr(node, 'data-test') ?? getAttr(node, 'data-cy');
  if (testId) {
    const attrName = getAttr(node, 'data-testid') != null ? 'data-testid'
      : getAttr(node, 'data-test') != null ? 'data-test' : 'data-cy';
    return `[${attrName}="${escapeCSSValue(testId)}"]`;
  }
  const id = getAttr(node, 'id');
  if (id && isStableId(id)) return `#${escapeCSSValue(id)}`;
  const tag = node.tagName.toLowerCase();
  if (FORM_TAGS.has(tag)) {
    const name = getAttr(node, 'name');
    if (name) return `${tag}[name="${escapeCSSValue(name)}"]`;
  }
  const ariaLabel = getAttr(node, 'aria-label');
  if (ariaLabel) return `${tag}[aria-label="${escapeCSSValue(ariaLabel)}"]`;
  return null;
}

function nthOfTypeIndex(node) {
  const parent = node.parentElement;
  if (!parent || !parent.children) return 1;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  const index = sameTag.indexOf(node);
  return index === -1 ? 1 : index + 1;
}

function segmentFor(node) {
  const tag = node.tagName.toLowerCase();
  return `${tag}${classChain(node)}:nth-of-type(${nthOfTypeIndex(node)})`;
}

/** Shortest-useful, stable CSS selector for `el` per the priority ladder in PROTOCOL.md. */
export function cssSelectorFor(el) {
  if (!el || !el.tagName) return '';
  const direct = stableSelectorFor(el);
  if (direct) return direct;
  const segments = [];
  let node = el;
  let guard = 0;
  while (node && node.tagName && guard < 100) {
    guard += 1;
    if (node !== el && hasUiMarker(node)) {
      node = node.parentElement;
      continue;
    }
    if (node !== el) {
      const anchor = stableSelectorFor(node);
      if (anchor) {
        segments.unshift(anchor);
        break;
      }
    }
    segments.unshift(segmentFor(node));
    if (node.tagName.toLowerCase() === 'body' || !node.parentElement) break;
    node = node.parentElement;
  }
  return segments.join(' > ');
}

function xpathIndex(node) {
  const parent = node.parentElement;
  if (!parent || !parent.children) return 1;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  const index = sameTag.indexOf(node);
  return index === -1 ? 1 : index + 1;
}

/** Absolute XPath with 1-based indices from the outermost reachable ancestor down to `el`. */
export function xpathFor(el) {
  if (!el || !el.tagName) return '';
  const segments = [];
  let node = el;
  let guard = 0;
  while (node && node.tagName && guard < 100) {
    guard += 1;
    segments.unshift(`${node.tagName.toLowerCase()}[${xpathIndex(node)}]`);
    node = node.parentElement || null;
  }
  return `/${segments.join('/')}`;
}

function getText(el) {
  if (typeof el.innerText === 'string') return el.innerText;
  if (typeof el.textContent === 'string') return el.textContent;
  return '';
}

function truncateLabel(s) {
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s;
}

function findAncestorLabelText(el) {
  let node = el.parentElement;
  let guard = 0;
  while (node && node.tagName && guard < 25) {
    if (node.tagName.toLowerCase() === 'label') {
      const text = getText(node).trim();
      return text || null;
    }
    node = node.parentElement;
    guard += 1;
  }
  return null;
}

/** The human name a person would use to refer to `el`. */
export function labelFor(el) {
  if (!el || !el.tagName) return '';
  const aria = getAttr(el, 'aria-label');
  if (aria && aria.trim()) return truncateLabel(aria.trim());
  const title = getAttr(el, 'title');
  if (title && title.trim()) return truncateLabel(title.trim());
  const alt = getAttr(el, 'alt');
  if (alt && alt.trim()) return truncateLabel(alt.trim());
  const placeholder = getAttr(el, 'placeholder');
  if (placeholder && placeholder.trim()) return truncateLabel(placeholder.trim());
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    const text = getText(el).trim();
    if (text) return truncateLabel(text);
  }
  const nearestLabel = findAncestorLabelText(el);
  return nearestLabel ? `<${tag}> ${truncateLabel(nearestLabel)}` : `<${tag}>`;
}

function collectAttrs(el) {
  const result = {};
  for (const key of ATTR_KEYS) {
    const value = getAttr(el, key);
    if (value != null && value !== '') result[key] = String(value);
  }
  return result;
}

function rectFor(el) {
  if (typeof el.getBoundingClientRect !== 'function') return { x: 0, y: 0, width: 0, height: 0 };
  const rect = el.getBoundingClientRect();
  const x = typeof rect.x === 'number' ? rect.x : rect.left || 0;
  const y = typeof rect.y === 'number' ? rect.y : rect.top || 0;
  return { x, y, width: rect.width || 0, height: rect.height || 0 };
}

function truncateText(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * @param {object} el a DOM-like element
 * @param {object} [opts] reserved for future use; currently unused
 * @returns {{selector:string,xpath:string,label:string,tagName:string,attrs:Record<string,string>,text:string,rect:{x:number,y:number,width:number,height:number}}}
 */
export function describeElement(el, opts = {}) {
  void opts;
  if (!el || !el.tagName) {
    throw new TypeError('describeElement requires a DOM element with a tagName');
  }
  return {
    selector: cssSelectorFor(el),
    xpath: xpathFor(el),
    label: labelFor(el),
    tagName: el.tagName.toLowerCase(),
    attrs: collectAttrs(el),
    text: truncateText(getText(el).trim(), TEXT_MAX),
    rect: rectFor(el),
  };
}
