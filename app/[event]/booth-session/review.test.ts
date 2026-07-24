import { describe, expect, test } from "bun:test";
import {
  ReviewDecisionGate,
  type ReviewChoice,
  type ReviewClock,
} from "./review";

class ManualReviewClock implements ReviewClock {
  private nextHandle = 0;
  readonly timers = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number) {
    const handle = ++this.nextHandle;
    this.timers.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  fire(handle = [...this.timers.keys()][0]) {
    const timer = this.timers.get(handle);
    if (!timer) return false;
    this.timers.delete(handle);
    timer.callback();
    return true;
  }
}

function setup(seconds = 5) {
  const clock = new ManualReviewClock();
  const decisions: ReviewChoice[] = [];
  const gate = new ReviewDecisionGate(
    seconds,
    (choice) => decisions.push(choice),
    clock,
  );
  return { clock, decisions, gate };
}

describe("ReviewDecisionGate", () => {
  test("automatically accepts after the configured five seconds", () => {
    const { clock, decisions, gate } = setup();

    gate.start();

    expect([...clock.timers.values()].map((timer) => timer.ms)).toEqual([5_000]);
    clock.fire();
    expect(decisions).toEqual(["accept"]);
  });

  test("More Time cancels automatic acceptance without deciding", () => {
    const { clock, decisions, gate } = setup();
    gate.start();
    const staleTimer = [...clock.timers.values()][0].callback;

    expect(gate.moreTime()).toBe(true);
    staleTimer();

    expect(clock.timers.size).toBe(0);
    expect(decisions).toEqual([]);
    expect(gate.accept()).toBe(true);
    expect(decisions).toEqual(["accept"]);
  });

  test("Retake before timeout wins and cancels the timer", () => {
    const { clock, decisions, gate } = setup();
    gate.start();

    expect(gate.retake()).toBe(true);

    expect(clock.timers.size).toBe(0);
    expect(decisions).toEqual(["retake"]);
  });

  test("a button and timer race has exactly one synchronous winner", () => {
    const timerWins = setup();
    timerWins.gate.start();
    const timerHandle = [...timerWins.clock.timers.keys()][0];
    const staleTimer = timerWins.clock.timers.get(timerHandle)!.callback;
    timerWins.clock.fire(timerHandle);

    expect(timerWins.gate.retake()).toBe(false);
    expect(timerWins.decisions).toEqual(["accept"]);

    const buttonWins = setup();
    buttonWins.gate.start();
    const staleButtonTimer = [...buttonWins.clock.timers.values()][0].callback;
    expect(buttonWins.gate.accept()).toBe(true);
    staleButtonTimer();

    expect(buttonWins.gate.retake()).toBe(false);
    expect(buttonWins.decisions).toEqual(["accept"]);
    staleTimer();
    expect(timerWins.decisions).toEqual(["accept"]);
  });

  test("repeated decisions and repeated More Time clicks lose", () => {
    const { decisions, gate } = setup();
    gate.start();

    expect(gate.moreTime()).toBe(true);
    expect(gate.moreTime()).toBe(false);
    expect(gate.retake()).toBe(true);
    expect(gate.retake()).toBe(false);
    expect(gate.accept()).toBe(false);
    expect(decisions).toEqual(["retake"]);
  });

  test("cancel prevents a stale unmount callback and all later decisions", () => {
    const { clock, decisions, gate } = setup();
    gate.start();
    const staleTimer = [...clock.timers.values()][0].callback;

    gate.cancel();
    staleTimer();

    expect(clock.timers.size).toBe(0);
    expect(gate.accept()).toBe(false);
    expect(gate.retake()).toBe(false);
    expect(gate.moreTime()).toBe(false);
    expect(decisions).toEqual([]);
  });
});
