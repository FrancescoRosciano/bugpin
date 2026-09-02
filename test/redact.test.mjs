import test from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactUrl, shouldRedactInputValue, truncate } from '../lib/redact.js';

const REDACTED = '«redacted»';

test('redactString returns input unchanged when disabled', () => {
  const s = 'api_key=abcd1234efgh5678';
  assert.equal(redactString(s, false), s);
});

test('redactString returns non-string input unchanged', () => {
  assert.equal(redactString(42, true), 42);
  assert.equal(redactString(null, true), null);
});

test('redactString masks sk- style keys', () => {
  assert.equal(redactString('key is sk-abcd1234efgh5678', true), `key is ${REDACTED}`);
});

test('redactString masks Bearer tokens, keeping the "Bearer " prefix', () => {
  assert.equal(
    redactString('Authorization: Bearer abc123.def456-ghi789', true),
    `Authorization: Bearer ${REDACTED}`,
  );
});

test('redactString masks JWTs (three base64url segments)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(redactString(`token: ${jwt}`, true), `token: ${REDACTED}`);
});

test('redactString masks api_key/apikey/token/secret/password/auth values (= form)', () => {
  assert.equal(redactString('api_key=abcd1234efgh5678', true), `api_key=${REDACTED}`);
  assert.equal(redactString('apikey=abcd1234efgh5678', true), `apikey=${REDACTED}`);
  assert.equal(redactString('secret=abcd1234efgh5678', true), `secret=${REDACTED}`);
});

test('redactString masks key/value pairs with a colon separator, preserving quotes', () => {
  assert.equal(redactString('"password": "hunter2hunter2"', true), `"password": "${REDACTED}"`);
  assert.equal(redactString("auth: 'letmein12345678'", true), `auth: '${REDACTED}'`);
});

test('redactString masks mixed-case base64-shaped blobs >= 32 chars', () => {
  // lower + upper + digits, 40 chars: the shape of a real API key / session id.
  const blob = 'aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdEfGh4JkLm';
  assert.equal(blob.length, 40);
  assert.equal(redactString(`upload id ${blob} done`, true), `upload id ${REDACTED} done`);
});

test('redactString leaves blobs shorter than 32 chars alone', () => {
  const blob = 'aB3dEfGh1jKlMn0pQrStUvWxYz2AbCdE'.slice(0, 31);
  assert.equal(blob.length, 31);
  assert.equal(redactString(`upload id ${blob} done`, true), `upload id ${blob} done`);
});

// --- BLOB_RE false positives (PROTOCOL §5: the blob rule is deliberately
// narrow; over-redaction destroys the diagnostics an export exists to carry).

test('redactString leaves single-case identifiers alone however long', () => {
  const hexId = '9f8e7d6c5b4a39281706958473625149'; // 32 lowercase hex chars
  assert.equal(redactString(`order id ${hexId}`, true), `order id ${hexId}`);

  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(redactString(`commit ${sha}`, true), `commit ${sha}`);

  const shout = 'A'.repeat(48); // no lower-case, no digits
  assert.equal(redactString(`banner ${shout}`, true), `banner ${shout}`);
});

test('redactString never shreds file paths in stack traces', () => {
  // Every char here is in the base64url alphabet and the run is > 32 chars,
  // so the old unbounded blob rule replaced the whole path with «redacted».
  const stack = 'at renderReport (/home/dev/projects/bugpin/lib/export.js:31:7)';
  assert.equal(redactString(stack, true), stack);
});

test('redactString leaves a long lowercase URL path untouched', () => {
  const line = 'GET https://cdn.example.com/assets/vendor/bundles/main-chunk-runtime.js 200';
  assert.equal(redactString(line, true), line);
});

test('redactString handles multiple secrets in one string', () => {
  const input = 'sk-abcd1234efgh5678 and Bearer zzz999yyy888 and token=xyz987';
  const out = redactString(input, true);
  assert.equal(out, `${REDACTED} and Bearer ${REDACTED} and token=${REDACTED}`);
});

test('redactUrl returns input unchanged when disabled', () => {
  const url = 'https://example.com/api?token=abc';
  assert.equal(redactUrl(url, false), url);
});

test('redactUrl keeps path and query keys, redacts sensitive values', () => {
  const url = 'https://example.com/api/users?token=abc123&page=2';
  assert.equal(
    redactUrl(url, true),
    `https://example.com/api/users?token=${encodeURIComponent(REDACTED)}&page=2`,
  );
});

test('redactUrl matches sensitive keys case-insensitively', () => {
  const url = 'https://example.com/x?Session=zzz&Api-Key=yyy';
  assert.equal(
    redactUrl(url, true),
    `https://example.com/x?Session=${encodeURIComponent(REDACTED)}&Api-Key=${encodeURIComponent(REDACTED)}`,
  );
});

test('redactUrl redacts duplicate keys and leaves unrelated keys intact', () => {
  const url = '/search?token=a&token=b&q=hello';
  assert.equal(
    redactUrl(url, true),
    `/search?token=${encodeURIComponent(REDACTED)}&token=${encodeURIComponent(REDACTED)}&q=hello`,
  );
});

test('redactUrl works on relative URLs and preserves the hash fragment', () => {
  const url = '/dash?auth=zzz#section-2';
  assert.equal(redactUrl(url, true), `/dash?auth=${encodeURIComponent(REDACTED)}#section-2`);
});

test('redactUrl leaves URLs without a query string untouched', () => {
  const url = '/plain/path/no-query';
  assert.equal(redactUrl(url, true), url);
});

test('redactUrl never throws on malformed input and returns it as-is', () => {
  assert.equal(redactUrl('not a url at all', true), 'not a url at all');
  assert.equal(redactUrl('%%%bad%%%?token=x', true), `%%%bad%%%?token=${encodeURIComponent(REDACTED)}`);
});

test('redactUrl leaves value-less query flags untouched', () => {
  const url = '/x?token&y=1';
  assert.equal(redactUrl(url, true), url);
});

test('redactUrl returns non-string / empty input unchanged', () => {
  assert.equal(redactUrl('', true), '');
  assert.equal(redactUrl(null, true), null);
});

test('shouldRedactInputValue is true for password inputs', () => {
  const el = { tagName: 'INPUT', attributes: { type: 'password' } };
  assert.equal(shouldRedactInputValue(el), true);
});

test('shouldRedactInputValue is true for autocomplete password/cc-/one-time-code', () => {
  assert.equal(shouldRedactInputValue({ tagName: 'INPUT', attributes: { autocomplete: 'current-password' } }), true);
  assert.equal(shouldRedactInputValue({ tagName: 'INPUT', attributes: { autocomplete: 'cc-number' } }), true);
  assert.equal(shouldRedactInputValue({ tagName: 'INPUT', attributes: { autocomplete: 'one-time-code' } }), true);
});

test('shouldRedactInputValue is true for [data-bugpin-redact]', () => {
  const el = { tagName: 'DIV', attributes: { 'data-bugpin-redact': '' } };
  assert.equal(shouldRedactInputValue(el), true);
});

test('shouldRedactInputValue works via a real getAttribute-style element', () => {
  const el = { tagName: 'INPUT', getAttribute: (name) => (name === 'type' ? 'password' : null) };
  assert.equal(shouldRedactInputValue(el), true);
});

test('shouldRedactInputValue is false for a plain text input and invalid elements', () => {
  const el = { tagName: 'INPUT', attributes: { type: 'text' } };
  assert.equal(shouldRedactInputValue(el), false);
  assert.equal(shouldRedactInputValue(null), false);
  assert.equal(shouldRedactInputValue({}), false);
});

test('truncate leaves strings at or under the max length untouched', () => {
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate cuts and appends the char-count suffix past the max', () => {
  assert.equal(truncate('hello world', 5), 'hello … (+6 chars)');
});

test('truncate passes through non-strings and invalid max unchanged', () => {
  assert.equal(truncate(42, 5), 42);
  assert.equal(truncate('hello', 'nope'), 'hello');
});
