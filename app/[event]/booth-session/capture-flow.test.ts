import { describe, expect, test } from "bun:test";
import {
  INITIAL_CAPTURE_FLOW_STATE,
  reduceCaptureFlow,
  type CaptureFlowState,
  type ReviewCandidate,
} from "./capture-flow";

const canvas = { width: 1200, height: 1800 } as HTMLCanvasElement;
const candidate: ReviewCandidate = {
  id: "candidate-current",
  source: "framed",
  frameKey: "lighthouse",
  canvas,
};

function capturing(
  frameKey = "lighthouse",
  captureAttemptId = "attempt-current",
): CaptureFlowState {
  return {
    ...INITIAL_CAPTURE_FLOW_STATE,
    phase: "capturing",
    frameKey,
    captureAttemptId,
  };
}

describe("reduceCaptureFlow", () => {
  test("an Event or pause reset releases every candidate and Frame", () => {
    const reviewing: CaptureFlowState = {
      phase: "reviewing",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate,
      autoAcceptPending: true,
      error: null,
    };

    expect(reduceCaptureFlow(reviewing, { type: "reset" })).toBe(
      INITIAL_CAPTURE_FLOW_STATE,
    );
  });

  test("a fresh Frame choice moves from picker through ready to capturing", () => {
    const ready = reduceCaptureFlow(INITIAL_CAPTURE_FLOW_STATE, {
      type: "select-frame",
      frameKey: "beacon",
    });
    expect(ready).toEqual({
      phase: "ready",
      frameKey: "beacon",
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: null,
    });

    expect(reduceCaptureFlow(ready, {
      type: "start-capture",
      attemptId: "attempt-framed",
    })).toEqual({
      ...ready,
      phase: "capturing",
      captureAttemptId: "attempt-framed",
    });
  });

  test("capture completion retains the selected Frame and enters timed review", () => {
    const next = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: true,
    });

    expect(next).toEqual({
      phase: "reviewing",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate,
      autoAcceptPending: true,
      error: null,
    });
  });

  test("capture failure returns to camera-ready with the same Frame", () => {
    expect(reduceCaptureFlow(capturing(), {
      type: "capture-failed",
      attemptId: "attempt-current",
      error: "Could not compose photo",
    })).toEqual({
      phase: "ready",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: "Could not compose photo",
    });
  });

  test("Retake returns to ready with the same Frame", () => {
    const reviewing = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: true,
    });

    expect(reduceCaptureFlow(reviewing, {
      type: "retake",
      candidateId: candidate.id,
    })).toEqual({
      phase: "ready",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: null,
    });
  });

  test("acceptance synchronously enters accepting and disables automatic acceptance", () => {
    const reviewing = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: true,
    });

    const accepting = reduceCaptureFlow(reviewing, {
      type: "accept",
      candidateId: candidate.id,
    });

    expect(accepting.phase).toBe("accepting");
    expect(accepting.candidate).toBe(candidate);
    expect(accepting.autoAcceptPending).toBe(false);
  });

  test("encode or enqueue failure returns the same candidate to untimed review", () => {
    const accepting: CaptureFlowState = {
      phase: "accepting",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate,
      autoAcceptPending: false,
      error: null,
    };

    expect(reduceCaptureFlow(accepting, {
      type: "accept-failed",
      candidateId: candidate.id,
      error: "Could not save the photo",
    })).toEqual({
      phase: "reviewing",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate,
      autoAcceptPending: false,
      error: "Could not save the photo",
    });
  });

  test("durable enqueue success clears the Frame and enters handoff", () => {
    const accepting: CaptureFlowState = {
      phase: "accepting",
      frameKey: "lighthouse",
      captureAttemptId: null,
      candidate,
      autoAcceptPending: false,
      error: null,
    };

    expect(reduceCaptureFlow(accepting, {
      type: "enqueue-succeeded",
      candidateId: candidate.id,
    })).toEqual({
      phase: "handoff",
      frameKey: null,
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: null,
    });
  });

  test("completed handoff resets to a fresh Frame picker", () => {
    const handoff: CaptureFlowState = {
      phase: "handoff",
      frameKey: null,
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: null,
    };

    expect(reduceCaptureFlow(handoff, { type: "handoff-complete" })).toBe(
      INITIAL_CAPTURE_FLOW_STATE,
    );
  });

  test("review-disabled capture moves directly to accepting", () => {
    const next = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: false,
    });

    expect(next.phase).toBe("accepting");
    expect(next.frameKey).toBe("lighthouse");
    expect(next.candidate).toBe(candidate);
    expect(next.autoAcceptPending).toBe(false);
  });

  test("More Time cancels only the current candidate's timer", () => {
    const reviewing = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: true,
    });

    const next = reduceCaptureFlow(reviewing, {
      type: "more-time",
      candidateId: candidate.id,
    });

    expect(next.phase).toBe("reviewing");
    expect(next.autoAcceptPending).toBe(false);
    expect(next.candidate).toBe(candidate);
  });

  test("stale candidate callbacks and actions are identity no-ops", () => {
    const reviewing = reduceCaptureFlow(capturing(), {
      type: "capture-complete",
      attemptId: "attempt-current",
      candidate,
      reviewEnabled: true,
    });
    const staleReviewActions = [
      { type: "more-time", candidateId: "candidate-old" },
      { type: "retake", candidateId: "candidate-old" },
      { type: "accept", candidateId: "candidate-old" },
    ] as const;
    const accepting = reduceCaptureFlow(reviewing, {
      type: "accept",
      candidateId: candidate.id,
    });
    const staleAcceptanceActions = [
      {
        type: "accept-failed",
        candidateId: "candidate-old",
        error: "stale failure",
      },
      { type: "enqueue-succeeded", candidateId: "candidate-old" },
    ] as const;

    for (const action of staleReviewActions) {
      expect(reduceCaptureFlow(reviewing, action)).toBe(reviewing);
    }
    for (const action of staleAcceptanceActions) {
      expect(reduceCaptureFlow(accepting, action)).toBe(accepting);
    }
  });

  test("camera fallback completes a legal frameless capture through handoff", () => {
    const fallbackCandidate: ReviewCandidate = {
      id: "candidate-fallback",
      source: "camera-fallback",
      canvas,
    };
    const capturingFallback = reduceCaptureFlow(INITIAL_CAPTURE_FLOW_STATE, {
      type: "start-fallback-capture",
      attemptId: "attempt-fallback",
    });
    expect(capturingFallback).toEqual({
      phase: "capturing",
      frameKey: null,
      captureAttemptId: "attempt-fallback",
      candidate: null,
      autoAcceptPending: false,
      error: null,
    });

    const reviewingFallback = reduceCaptureFlow(capturingFallback, {
      type: "capture-complete",
      attemptId: "attempt-fallback",
      candidate: fallbackCandidate,
      reviewEnabled: true,
    });
    expect(reviewingFallback).toEqual({
      phase: "reviewing",
      frameKey: null,
      captureAttemptId: null,
      candidate: fallbackCandidate,
      autoAcceptPending: true,
      error: null,
    });

    const acceptingFallback = reduceCaptureFlow(reviewingFallback, {
      type: "accept",
      candidateId: fallbackCandidate.id,
    });
    expect(acceptingFallback.phase).toBe("accepting");
    expect(reduceCaptureFlow(acceptingFallback, {
      type: "enqueue-succeeded",
      candidateId: fallbackCandidate.id,
    })).toEqual({
      phase: "handoff",
      frameKey: null,
      captureAttemptId: null,
      candidate: null,
      autoAcceptPending: false,
      error: null,
    });
  });

  test("an old completion after Retake and a new start cannot install its candidate", () => {
    const ready = reduceCaptureFlow(INITIAL_CAPTURE_FLOW_STATE, {
      type: "select-frame",
      frameKey: "lighthouse",
    });
    const firstCapture = reduceCaptureFlow(ready, {
      type: "start-capture",
      attemptId: "attempt-first",
    });
    const firstReview = reduceCaptureFlow(firstCapture, {
      type: "capture-complete",
      attemptId: "attempt-first",
      candidate,
      reviewEnabled: true,
    });
    const readyAgain = reduceCaptureFlow(firstReview, {
      type: "retake",
      candidateId: candidate.id,
    });
    const secondCapture = reduceCaptureFlow(readyAgain, {
      type: "start-capture",
      attemptId: "attempt-second",
    });
    const staleCandidate: ReviewCandidate = {
      ...candidate,
      id: "candidate-stale",
    };

    expect(reduceCaptureFlow(secondCapture, {
      type: "capture-complete",
      attemptId: "attempt-first",
      candidate: staleCandidate,
      reviewEnabled: true,
    })).toBe(secondCapture);

    const secondCandidate: ReviewCandidate = {
      ...candidate,
      id: "candidate-second",
    };
    expect(reduceCaptureFlow(secondCapture, {
      type: "capture-complete",
      attemptId: "attempt-second",
      candidate: secondCandidate,
      reviewEnabled: true,
    }).candidate).toBe(secondCandidate);
  });
});
