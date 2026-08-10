import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, placeBeside, placeAboveOrBelow, pinAnchorPoint } from '../lib/anchor.js';

const viewport = { width: 1000, height: 800 };

test('clamp keeps value inside range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
});

test('clamp tolerates a reversed min/max pair', () => {
  assert.equal(clamp(5, 10, 0), 5);
  assert.equal(clamp(-5, 10, 0), 0);
});

test('placeBeside prefers the right side when there is room', () => {
  const anchor = { top: 100, left: 100, right: 200, bottom: 140 };
  const size = { width: 280, height: 150 };
  const pos = placeBeside({ anchor, size, viewport, margin: 10 });
  assert.equal(pos.x, 210);
  assert.equal(pos.y, 100);
});

test('placeBeside flips to the left when the right side has no room', () => {
  const anchor = { top: 100, left: 850, right: 950, bottom: 140 };
  const size = { width: 280, height: 150 };
  const pos = placeBeside({ anchor, size, viewport, margin: 10 });
  assert.equal(pos.x, 850 - 10 - 280);
});

test('placeBeside clamps horizontally when neither side fits', () => {
  const anchor = { top: 100, left: 10, right: 990, bottom: 140 };
  const size = { width: 280, height: 150 };
  const pos = placeBeside({ anchor, size, viewport, margin: 10 });
  assert.ok(pos.x >= 10);
  assert.ok(pos.x + size.width <= viewport.width - 10);
});

test('placeBeside clamps vertically so the box stays in the viewport', () => {
  const anchor = { top: 780, left: 100, right: 200, bottom: 790 };
  const size = { width: 280, height: 150 };
  const pos = placeBeside({ anchor, size, viewport, margin: 10 });
  assert.ok(pos.y + size.height <= viewport.height - 10);
});

test('placeAboveOrBelow prefers above when there is room', () => {
  const anchor = { top: 400, left: 100, right: 200, bottom: 440 };
  const size = { width: 200, height: 40 };
  const pos = placeAboveOrBelow({ anchor, size, viewport, margin: 8 });
  assert.equal(pos.y, 400 - 8 - 40);
  assert.equal(pos.x, 100);
});

test('placeAboveOrBelow flips below when there is no room above', () => {
  const anchor = { top: 20, left: 100, right: 200, bottom: 60 };
  const size = { width: 200, height: 40 };
  const pos = placeAboveOrBelow({ anchor, size, viewport, margin: 8 });
  assert.equal(pos.y, 60 + 8);
});

test('placeAboveOrBelow clamps horizontally inside the viewport', () => {
  const anchor = { top: 400, left: 950, right: 990, bottom: 440 };
  const size = { width: 200, height: 40 };
  const pos = placeAboveOrBelow({ anchor, size, viewport, margin: 8 });
  assert.ok(pos.x + size.width <= viewport.width - 8);
});

test('pinAnchorPoint centers a badge on the top-right corner of a rect', () => {
  const rect = { top: 100, right: 200 };
  const pos = pinAnchorPoint({ rect, viewport, size: { width: 20, height: 20 }, margin: 2 });
  assert.equal(pos.x, 190);
  assert.equal(pos.y, 90);
});

test('pinAnchorPoint clamps near the viewport edges', () => {
  const rect = { top: 2, right: 998 };
  const pos = pinAnchorPoint({ rect, viewport, size: { width: 20, height: 20 }, margin: 2 });
  assert.ok(pos.x + 20 <= viewport.width - 2 + 0.001);
  assert.ok(pos.y >= 2 - 0.001);
});
