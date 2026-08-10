import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeElement,
  cssSelectorFor,
  xpathFor,
  labelFor,
  isStableId,
  classChain,
  escapeCSSValue,
} from '../lib/selector.js';
import { UI_MARKER } from '../lib/messages.js';

/** Builds a hand-rolled fake DOM element using only the properties selector.js may read. */
function createElement(tag, opts = {}, children = []) {
  const { id = '', className = '', attrs = {}, text = '', rect, noRect = false } = opts;
  const node = {
    tagName: tag.toUpperCase(),
    id,
    className,
    attributes: { ...attrs, ...(id ? { id } : {}), ...(className ? { class: className } : {}) },
    parentElement: null,
    children: [],
    textContent: text,
    innerText: text,
  };
  if (!noRect) {
    node.getBoundingClientRect = () => rect || { x: 0, y: 0, width: 0, height: 0 };
  }
  for (const child of children) {
    child.parentElement = node;
    node.children.push(child);
  }
  return node;
}

test('isStableId rejects digit-only chunks, hashes, and UUIDs', () => {
  assert.equal(isStableId('main-content'), true);
  assert.equal(isStableId('container'), true);
  assert.equal(isStableId('row-3'), false);
  assert.equal(isStableId('item-482910'), false);
  assert.equal(isStableId('a1b2c3d4e5'), false);
  assert.equal(isStableId('123e4567-e89b-12d3-a456-426614174000'), false);
  assert.equal(isStableId(''), false);
  assert.equal(isStableId(null), false);
});

test('classChain keeps only stable class tokens, escaped and dotted', () => {
  const el = createElement('div', { className: 'card active-42 col:1' });
  assert.equal(classChain(el), '.card.col\\:1');
});

test('classChain returns empty string when no classes qualify', () => {
  const el = createElement('div', { className: 'a1b2c3d4e5 99' });
  assert.equal(classChain(el), '');
});

test('escapeCSSValue escapes special characters via the local fallback', () => {
  assert.equal(escapeCSSValue('a:b'), 'a\\:b');
  assert.equal(escapeCSSValue('1abc')[0], '\\');
});

test('cssSelectorFor prefers data-testid over everything else', () => {
  const el = createElement('button', { attrs: { 'data-testid': 'save-btn' }, id: 'x-123' });
  assert.equal(cssSelectorFor(el), '[data-testid="save-btn"]');
});

test('cssSelectorFor falls back through data-test then data-cy', () => {
  const dataTest = createElement('div', { attrs: { 'data-test': 'panel' } });
  assert.equal(cssSelectorFor(dataTest), '[data-test="panel"]');
  const dataCy = createElement('div', { attrs: { 'data-cy': 'panel' } });
  assert.equal(cssSelectorFor(dataCy), '[data-cy="panel"]');
});

test('cssSelectorFor uses a stable #id', () => {
  const el = createElement('section', { id: 'main-content' });
  assert.equal(cssSelectorFor(el), '#main-content');
});

test('cssSelectorFor skips an unstable id and falls through the ladder', () => {
  const el = createElement('input', { id: 'field-9f3c2a1b', attrs: { name: 'email' } });
  assert.equal(cssSelectorFor(el), 'input[name="email"]');
});

test('cssSelectorFor uses [aria-label] when nothing more specific matches', () => {
  const el = createElement('button', { attrs: { 'aria-label': 'Close' } });
  assert.equal(cssSelectorFor(el), 'button[aria-label="Close"]');
});

test('cssSelectorFor walks tag + class chain + :nth-of-type() up to a stable ancestor', () => {
  const li = createElement('li', { className: 'list-item' });
  const ul = createElement('ul', {}, [li]);
  createElement('div', { id: 'stable-id' }, [ul]);
  assert.equal(cssSelectorFor(li), '#stable-id > ul:nth-of-type(1) > li.list-item:nth-of-type(1)');
});

test('cssSelectorFor walks all the way up to body when no ancestor is stable', () => {
  const li = createElement('li', { className: 'list-item' });
  const ul = createElement('ul', {}, [li]);
  const div = createElement('div', { id: 'app-root-9f3c2a1b', className: 'container' }, [ul]);
  createElement('body', {}, [div]);
  assert.equal(
    cssSelectorFor(li),
    'body:nth-of-type(1) > div.container:nth-of-type(1) > ul:nth-of-type(1) > li.list-item:nth-of-type(1)',
  );
});

test('cssSelectorFor skips ancestors carrying the UI_MARKER attribute', () => {
  const span = createElement('span', {});
  const wrapper = createElement('div', { attrs: { [UI_MARKER]: '' } }, [span]);
  createElement('body', {}, [wrapper]);
  assert.equal(cssSelectorFor(span), 'body:nth-of-type(1) > span:nth-of-type(1)');
});

test('cssSelectorFor computes nth-of-type among same-tag siblings only', () => {
  const target = createElement('li', {});
  const ul = createElement('ul', {}, [
    createElement('li', {}),
    createElement('span', {}),
    target,
  ]);
  createElement('body', {}, [ul]);
  assert.match(cssSelectorFor(target), /li:nth-of-type\(2\)$/);
});

test('cssSelectorFor returns empty string for a non-element input', () => {
  assert.equal(cssSelectorFor(null), '');
  assert.equal(cssSelectorFor({}), '');
});

test('xpathFor builds an absolute path with 1-based indices', () => {
  const target = createElement('span', {});
  const div = createElement('div', {}, [createElement('p', {}), target]);
  const body = createElement('body', {}, [div]);
  createElement('html', {}, [body]);
  assert.equal(xpathFor(target), '/html[1]/body[1]/div[1]/span[1]');
});

test('xpathFor indexes repeated siblings correctly', () => {
  const third = createElement('li', {});
  createElement('ul', {}, [createElement('li', {}), createElement('li', {}), third]);
  assert.equal(xpathFor(third), '/ul[1]/li[3]');
});

test('labelFor prioritises aria-label, then title, alt, placeholder', () => {
  assert.equal(labelFor(createElement('button', { attrs: { 'aria-label': 'Close dialog' } })), 'Close dialog');
  assert.equal(labelFor(createElement('div', { attrs: { title: 'Tooltip text' } })), 'Tooltip text');
  assert.equal(labelFor(createElement('img', { attrs: { alt: 'Logo' } })), 'Logo');
  assert.equal(labelFor(createElement('input', { attrs: { placeholder: 'Search…' } })), 'Search…');
});

test('labelFor uses trimmed, truncated innerText for buttons and links', () => {
  const longText = `  ${'x'.repeat(80)}  `;
  const btn = createElement('button', { text: longText });
  const label = labelFor(btn);
  assert.equal(label.length, 60);
  assert.equal(label, 'x'.repeat(60));
});

test('labelFor falls back to <tag> plus the nearest wrapping label text', () => {
  const input = createElement('input', {});
  const label = createElement('label', { text: 'Email address' }, [input]);
  void label;
  assert.equal(labelFor(input), '<input> Email address');
});

test('labelFor falls back to bare <tag> when nothing else is found', () => {
  const el = createElement('div', {});
  assert.equal(labelFor(el), '<div>');
});

test('describeElement assembles the full shape', () => {
  const target = createElement('a', {
    id: 'nav-home',
    className: 'link primary',
    attrs: { href: '/home', 'aria-label': 'Home' },
    text: '  Home  ',
    rect: { x: 10, y: 20, width: 100, height: 40 },
  });
  const result = describeElement(target);
  assert.equal(result.tagName, 'a');
  assert.equal(result.selector, '#nav-home');
  assert.equal(result.xpath, '/a[1]');
  assert.equal(result.label, 'Home');
  assert.deepEqual(result.attrs, { id: 'nav-home', class: 'link primary', href: '/home', 'aria-label': 'Home' });
  assert.equal(result.text, 'Home');
  assert.deepEqual(result.rect, { x: 10, y: 20, width: 100, height: 40 });
});

test('describeElement truncates text to 200 chars and defaults rect without getBoundingClientRect', () => {
  const target = createElement('p', { text: 'y'.repeat(250), noRect: true });
  const result = describeElement(target);
  assert.equal(result.text.length, 200);
  assert.deepEqual(result.rect, { x: 0, y: 0, width: 0, height: 0 });
});

test('describeElement throws for a non-element input', () => {
  assert.throws(() => describeElement(null), TypeError);
  assert.throws(() => describeElement({}), TypeError);
});
