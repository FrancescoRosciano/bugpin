/**
 * Pure geometry helpers for the annotate overlay (content-annotate.js).
 * No DOM access here — everything takes plain rect/size/viewport objects so
 * it can be unit tested with node --test (see test/anchor.test.mjs).
 */

/** Clamp `value` between `min` and `max` (order-independent). */
export function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Place a box beside an anchor rect: prefer the right side, flip to the
 * left if there is no room, otherwise clamp horizontally inside the
 * viewport. Vertically anchored near the top of the rect, clamped to fit.
 * @param {{anchor: {top:number,left:number,right:number,bottom:number}, size:{width:number,height:number}, viewport:{width:number,height:number}, margin?: number}} opts
 */
export function placeBeside({ anchor, size, viewport, margin = 10 }) {
  const spaceRight = viewport.width - anchor.right - margin;
  const spaceLeft = anchor.left - margin;
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const x = spaceRight >= size.width
    ? anchor.right + margin
    : spaceLeft >= size.width
      ? anchor.left - margin - size.width
      : clamp(anchor.left, margin, maxX);

  const maxY = Math.max(margin, viewport.height - size.height - margin);
  const y = clamp(anchor.top, margin, maxY);

  return { x: clamp(x, margin, maxX), y };
}

/**
 * Place a box above or below an anchor rect: prefer above, flip below if
 * there is no room, otherwise clamp vertically. Horizontally aligned to the
 * left of the anchor, clamped to fit the viewport.
 * @param {{anchor: {top:number,left:number,right:number,bottom:number}, size:{width:number,height:number}, viewport:{width:number,height:number}, margin?: number}} opts
 */
export function placeAboveOrBelow({ anchor, size, viewport, margin = 8 }) {
  const spaceAbove = anchor.top - margin;
  const spaceBelow = viewport.height - anchor.bottom - margin;
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  const y = spaceAbove >= size.height
    ? anchor.top - margin - size.height
    : spaceBelow >= size.height
      ? anchor.bottom + margin
      : clamp(anchor.top, margin, maxY);

  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const x = clamp(anchor.left, margin, maxX);

  return { x, y: clamp(y, margin, maxY) };
}

/**
 * Anchor point for a numbered pin badge at an element's top-right corner,
 * clamped so the badge never falls outside the viewport.
 * @param {{rect: {top:number,right:number}, viewport:{width:number,height:number}, size?: {width:number,height:number}, margin?: number}} opts
 */
export function pinAnchorPoint({ rect, viewport, size = { width: 20, height: 20 }, margin = 2 }) {
  const rawX = rect.right - size.width / 2;
  const rawY = rect.top - size.height / 2;
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return { x: clamp(rawX, margin, maxX), y: clamp(rawY, margin, maxY) };
}
