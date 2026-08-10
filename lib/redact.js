/**
 * Secret / PII scrubbing used by every event producer before storage. See
 * PROTOCOL.md §5 "Redaction". Replacement text is exactly «redacted».
 */

const REDACTED = '«redacted»';

const SK_RE = /sk-[A-Za-z0-9]{8,}/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const KV_RE = /\b(api[_-]?key|apikey|token|secret|password|auth)(["']?)(\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9+/=_.~-]+))/gi;
/**
 * A standalone opaque token (PROTOCOL §5). Deliberately narrow: the run must
 * be >= 32 base64url chars AND mix lower-case, upper-case and digits — the
 * shape of a real base64/API-key secret. Single-case runs (hex ids, git SHAs,
 * slugs) and anything touching a `/` (file paths, URL path segments) are left
 * alone, because over-redaction destroys the diagnostics an export exists to
 * carry. The `/`-excluding boundaries are what keep stack-trace paths intact.
 */
const BLOB_RE =
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+_=-]*[a-z])(?=[A-Za-z0-9+_=-]*[A-Z])(?=[A-Za-z0-9+_=-]*[0-9])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
const SENSITIVE_QUERY_RE = /token|key|secret|password|auth|session|sig/i;

function redactBearer(match) {
  const spaceIndex = match.search(/\S+$/);
  return `${match.slice(0, spaceIndex)}${REDACTED}`;
}

function redactKeyValue(match, key, keyQuote, sep, dq, sq) {
  const prefix = `${key}${keyQuote}${sep}`;
  if (dq !== undefined) return `${prefix}"${REDACTED}"`;
  if (sq !== undefined) return `${prefix}'${REDACTED}'`;
  return `${prefix}${REDACTED}`;
}

/**
 * Masks secret-shaped substrings: sk-… keys, Bearer tokens, JWTs, key=value /
 * key: value secrets, and long mixed-case base64 blobs (see BLOB_RE). Returns
 * `s` unchanged when `enabled` is false or `s` is not a string.
 */
export function redactString(s, enabled) {
  if (!enabled || typeof s !== 'string') return s;
  let out = s;
  out = out.replace(SK_RE, REDACTED);
  out = out.replace(BEARER_RE, redactBearer);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(KV_RE, redactKeyValue);
  out = out.replace(BLOB_RE, REDACTED);
  return out;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactQueryPair(pair) {
  if (!pair) return pair;
  const eqIndex = pair.indexOf('=');
  if (eqIndex === -1) return pair;
  const key = pair.slice(0, eqIndex);
  if (!SENSITIVE_QUERY_RE.test(safeDecode(key))) return pair;
  return `${key}=${encodeURIComponent(REDACTED)}`;
}

/**
 * Keeps the path and query KEYS of `url`, redacts values of keys matching
 * /token|key|secret|password|auth|session|sig/i. Never throws — malformed or
 * relative URLs, or anything without a query string, are returned unchanged.
 * Returns `url` unchanged when `enabled` is false.
 */
export function redactUrl(url, enabled) {
  if (!enabled || typeof url !== 'string' || !url) return url;
  try {
    const hashIndex = url.indexOf('#');
    const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    const queryIndex = withoutHash.indexOf('?');
    if (queryIndex === -1) return url;
    const base = withoutHash.slice(0, queryIndex);
    const query = withoutHash.slice(queryIndex + 1);
    const redactedQuery = query.split('&').map(redactQueryPair).join('&');
    return `${base}?${redactedQuery}${hash}`;
  } catch {
    return url;
  }
}

function getAttrValue(el, name) {
  if (!el) return null;
  if (typeof el.getAttribute === 'function') {
    const value = el.getAttribute(name);
    return value == null ? null : value;
  }
  if (el.attributes) {
    if (typeof el.attributes.getNamedItem === 'function') {
      const node = el.attributes.getNamedItem(name);
      return node ? node.value : null;
    }
    if (Object.prototype.hasOwnProperty.call(el.attributes, name)) return el.attributes[name];
  }
  return null;
}

/**
 * True when `el`'s value must never be recorded: password inputs, fields
 * with autocomplete containing "password" / "cc-" / "one-time-code", or
 * anything carrying [data-bugpin-redact].
 */
export function shouldRedactInputValue(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  const type = getAttrValue(el, 'type');
  if (tag === 'input' && typeof type === 'string' && type.toLowerCase() === 'password') return true;
  const autocomplete = getAttrValue(el, 'autocomplete');
  if (typeof autocomplete === 'string') {
    const ac = autocomplete.toLowerCase();
    if (ac.includes('password') || ac.includes('cc-') || ac.includes('one-time-code')) return true;
  }
  return getAttrValue(el, 'data-bugpin-redact') != null;
}

/** Slices `s` to `max` chars, appending " … (+N chars)" (N = chars cut) when it cuts. */
export function truncate(s, max) {
  if (typeof s !== 'string') return s;
  if (typeof max !== 'number' || s.length <= max) return s;
  const cut = s.length - max;
  return `${s.slice(0, max)} … (+${cut} chars)`;
}
