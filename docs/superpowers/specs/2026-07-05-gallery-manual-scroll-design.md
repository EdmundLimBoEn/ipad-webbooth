# Live gallery: manual scroll of the marquee

**Date:** 2026-07-05
**Status:** Approved

## Problem

Since the per-column marquee rewrite, the live gallery page does not actually
scroll: each column is moved by `translateY` inside an overflow-hidden
viewport, and each column loops at its own period. The existing "pause on
interaction" handler only freezes the animation — a wheel or swipe moves
nothing. Viewers (phone or projector-side) need to browse back through photos.

## Decision

**Drag the marquee.** One shared scroll offset: wheel or touch-drag moves all
columns together along the same infinite loop — scroll down goes forward, up
goes back, wrapping forever. No mode switch. Auto-scroll resumes 4 seconds
after the last interaction, reusing today's idle-timer behavior.

Rejected alternatives:
- **Browse-mode toggle** (freeze marquee, switch to a finite scrollable grid):
  two modes to maintain, conventional but heavier.
- **Per-column drag**: columns desync when you swipe one; feels odd.

## Behavior

- Wheel: `deltaY` px scrolls the marquee (down = forward, up = back).
- Touch/pointer drag: content tracks the finger 1:1; on release, a momentum
  fling (velocity carried into the animation loop, decaying ~5% per frame)
  so flicks feel native on phones.
- Every interaction bumps the existing 4s idle timer; auto-scroll resumes
  4s after the fling settles.
- Scrolling backward past the start wraps (negative-safe modulo).
- Tap vs drag: pointer movement over ~10px suppresses the tile click, so a
  drag never opens the lightbox. A clean tap still opens it.
- When all photos fit on one screen (`!animate`), there is nothing to
  scroll; drag does nothing (unchanged).
- Lightbox open still pauses the marquee (unchanged).

## Implementation

All in `app/[event]/live/page.tsx` inside the existing marquee `useEffect`,
plus one CSS line:

1. Extract a pure wrap function (e.g. `wrap(pos, delta, period)` →
   `((pos + delta) % period + period) % period`) used by a `move(deltaPx)`
   helper that advances every column's `posRef` and sets its transform. The
   rAF step becomes `move(SPEED * dt)` when not idle/lightboxed.
2. Add a `wheel` listener calling `move(e.deltaY)` and bumping the idle
   timer (today wheel only bumps).
3. Pointer handlers: `pointerdown` records y; `pointermove` calls
   `move(lastY - y)` and tracks velocity; `pointerup` seeds the momentum
   velocity, which the rAF loop applies and decays until negligible.
4. Drag-suppresses-click: a ref flag set when cumulative movement exceeds
   ~10px, checked in the tile `onClick`.
5. CSS: `touch-action: none` on `.grid` in `live.module.css` so iOS
   rubber-banding doesn't fight the drag. The lightbox is `position: fixed`
   outside `.grid` and keeps native behavior.

New photos arriving mid-drag re-render and re-measure periods as they do
today; `posRef` persists, so behavior is unchanged from the current marquee.

## Testing

- `wrap()` is pure and unit-tested with `bun:test`: forward wrap, negative
  delta wrap, delta larger than one period, zero period guard.
- Pointer/rAF/momentum behavior is manual QA on a phone and desktop wheel.
