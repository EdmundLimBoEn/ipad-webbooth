# Live Gallery Manual Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let viewers wheel/drag the live-gallery marquee (all columns move together, wrapping infinitely), with momentum flings on touch; auto-scroll resumes 4s after the last interaction.

**Architecture:** The gallery (`app/[event]/live/page.tsx`) animates each column via `translateY` from a rAF loop; positions live in `posRef`, loop periods in `periodsRef`. We extract a pure `wrap()` helper, add a shared `move(delta)` that advances every column, and feed it from wheel events, pointer drags, a decaying fling velocity, and the existing auto-scroll tick. A drag-distance ref suppresses the tile click after a drag.

**Tech Stack:** Next.js App Router client component, React refs + rAF, `bun:test`. No new dependencies.

## Global Constraints

- Package manager/test runner is **Bun** (`bun test`, `bun run build`).
- No new dependencies.
- Auto-scroll idle resume delay: **4000 ms** (existing behavior, keep).
- Momentum decay: velocity × 0.95 per frame at 60fps, frame-rate independent (`Math.pow(0.95, dt * 60)`).
- Tap-vs-drag threshold: **10 px** cumulative pointer movement.
- The path `app/[event]` contains literal brackets — quote it in shell commands.

---

### Task 1: Pure `wrap()` helper with tests

**Files:**
- Create: `app/[event]/live/wrap.ts`
- Test: `app/[event]/live/wrap.test.ts`

**Interfaces:**
- Produces: `export function wrap(pos: number, period: number): number` — maps any position (including negative) into `[0, period)`; returns `0` when `period <= 0`. Task 2 imports this.

- [ ] **Step 1: Write the failing test**

Create `app/[event]/live/wrap.test.ts`:

```ts
import { expect, test } from "bun:test";
import { wrap } from "./wrap";

test("in-range position is unchanged", () => {
  expect(wrap(150, 400)).toBe(150);
});

test("forward wrap past the period", () => {
  expect(wrap(450, 400)).toBe(50);
});

test("negative position wraps to the end", () => {
  expect(wrap(-50, 400)).toBe(350);
});

test("delta larger than several periods", () => {
  expect(wrap(1250, 400)).toBe(50);
  expect(wrap(-1250, 400)).toBe(350);
});

test("exact period lands on zero", () => {
  expect(wrap(400, 400)).toBe(0);
});

test("zero or negative period returns 0", () => {
  expect(wrap(123, 0)).toBe(0);
  expect(wrap(123, -5)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test "app/[event]/live/wrap.test.ts"`
Expected: FAIL — cannot resolve `./wrap`.

- [ ] **Step 3: Write minimal implementation**

Create `app/[event]/live/wrap.ts`:

```ts
// Map any position (including negative) into [0, period).
export function wrap(pos: number, period: number): number {
  if (period <= 0) return 0;
  return ((pos % period) + period) % period;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test "app/[event]/live/wrap.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add "app/[event]/live/wrap.ts" "app/[event]/live/wrap.test.ts"
git commit -m "feat: wrap() helper for marquee position wrapping"
```

---

### Task 2: Wire wheel, drag, and momentum into the marquee

**Files:**
- Modify: `app/[event]/live/page.tsx` (marquee effect ~lines 94–130, tile `onClick` ~line 188, add one ref near line 33)
- Modify: `app/[event]/live/live.module.css` (`.grid` rule)

**Interfaces:**
- Consumes: `wrap(pos, period)` from Task 1 (`./wrap`).
- Produces: user-facing behavior only; no exports.

- [ ] **Step 1: Add the drag-distance ref and import**

In `app/[event]/live/page.tsx`, add to the imports:

```ts
import { wrap } from "./wrap";
```

Next to the existing `fullRef` declaration (after line 33), add:

```ts
// cumulative pointer travel of the last drag; >10px suppresses the tile click
const dragDistRef = useRef(0);
```

- [ ] **Step 2: Replace the marquee effect**

Replace the entire `useEffect(() => { ... }, [animate])` marquee effect (currently lines 94–130) with:

```ts
// Projector marquee: creep every column up forever. Each column wraps at its
// own period (its content is duplicated), so all screen space stays filled.
// Viewers can also scroll it: wheel and touch-drag move all columns together
// (with a momentum fling on release), and auto-scroll resumes 4s after the
// last interaction. Pauses while a photo is open.
useEffect(() => {
  if (!animate) {
    posRef.current = [];
    colRefs.current.forEach((el) => {
      if (el) el.style.transform = "";
    });
    return;
  }
  let raf = 0;
  let last: number | null = null;
  let idleUntil = 0;
  let velocity = 0; // px/sec fling from a drag release, decays in step()
  let dragY: number | null = null; // pointer y while dragging, else null
  let lastMoveT = 0;
  const bump = () => {
    idleUntil = performance.now() + 4000;
  };

  const move = (delta: number) => {
    colRefs.current.forEach((el, i) => {
      const period = periodsRef.current[i];
      if (!el || !period) return;
      const pos = wrap((posRef.current[i] ?? 0) + delta, period);
      posRef.current[i] = pos;
      el.style.transform = `translateY(${-pos}px)`;
    });
  };

  const onWheel = (e: WheelEvent) => {
    if (fullRef.current) return;
    bump();
    velocity = 0;
    move(e.deltaY);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (fullRef.current) return;
    bump();
    velocity = 0;
    dragY = e.clientY;
    lastMoveT = performance.now();
    dragDistRef.current = 0;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragY === null || fullRef.current) return;
    bump();
    const dy = dragY - e.clientY;
    dragY = e.clientY;
    const now = performance.now();
    const dt = (now - lastMoveT) / 1000;
    lastMoveT = now;
    if (dt > 0) velocity = dy / dt;
    dragDistRef.current += Math.abs(dy);
    move(dy);
  };
  const onPointerEnd = () => {
    dragY = null;
    bump();
  };

  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerEnd, { passive: true });
  window.addEventListener("pointercancel", onPointerEnd, { passive: true });
  window.addEventListener("keydown", bump, { passive: true });

  const step = (t: number) => {
    const dt = last === null ? 0 : Math.min((t - last) / 1000, 0.1);
    last = t;
    if (!fullRef.current && dragY === null) {
      if (Math.abs(velocity) > 1) {
        move(velocity * dt);
        velocity *= Math.pow(0.95, dt * 60); // frame-rate-independent decay
        bump(); // keep auto-scroll paused until the fling settles
      } else if (t > idleUntil) {
        velocity = 0;
        move(SPEED * dt);
      }
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    window.removeEventListener("keydown", bump);
  };
}, [animate]);
```

Note: the old `events.forEach(...bump...)` block (`wheel`/`touchstart`/`pointerdown`/`keydown` → pause-only) is gone; these handlers replace it.

- [ ] **Step 3: Suppress the tile click after a drag**

Change the tile's `onClick` (currently `onClick={() => setFull(p.url)}` around line 188) to:

```tsx
onClick={() => {
  if (dragDistRef.current > 10) return; // was a drag, not a tap
  setFull(p.url);
}}
```

- [ ] **Step 4: Prevent native touch handling on the grid**

In `app/[event]/live/live.module.css`, add to the `.grid` rule:

```css
.grid {
  display: flex;
  gap: 12px;
  height: 100%;
  touch-action: none; /* drags drive the marquee, not iOS rubber-banding */
}
```

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: PASS — all existing suites (`templates`, `crc32`, `upload-auth`) plus the 6 `wrap` tests.

- [ ] **Step 6: Production build**

Run: `bun run build`
Expected: build completes with no type errors.

- [ ] **Step 7: Commit**

```bash
git add "app/[event]/live/page.tsx" "app/[event]/live/live.module.css"
git commit -m "feat: manual scroll + momentum fling on the live gallery marquee"
```

---

### Task 3: Manual QA (human-in-the-loop)

**Files:** none.

**Interfaces:** none — verification only.

- [ ] **Step 1: Run the dev server**

Run: `bun dev`, open `http://localhost:3000/<event>/live` for an event with enough photos to overflow one screen.

- [ ] **Step 2: Verify on desktop**

- Wheel down: marquee scrolls forward faster than the creep; wheel up scrolls back and wraps past the start with no visible jump.
- Mouse drag: content tracks the pointer; releasing after a fast drag flings with decay.
- After ~4s of no input, the slow auto-creep resumes.
- A plain click on a photo still opens the lightbox; a drag that ends on a photo does not.
- With the lightbox open, wheel/drag do nothing; closing it resumes after 4s.

- [ ] **Step 3: Verify on a phone (real device)**

- Touch drag tracks the finger 1:1, no page rubber-banding.
- A flick coasts and settles; auto-scroll resumes ~4s later.
- Tap still opens the lightbox; Save photo still works.

Record any failures and fix before shipping.
