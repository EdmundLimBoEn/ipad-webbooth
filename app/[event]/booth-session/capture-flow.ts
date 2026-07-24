export type CapturePhase =
  | "picker"
  | "ready"
  | "capturing"
  | "reviewing"
  | "accepting"
  | "handoff";

export type ReviewCandidate = {
  id: string;
  source: "framed" | "camera-fallback";
  frameKey?: string;
  canvas: HTMLCanvasElement;
};

export type CaptureFlowState = {
  phase: CapturePhase;
  frameKey: string | null;
  candidate: ReviewCandidate | null;
  autoAcceptPending: boolean;
  error: string | null;
};

export type CaptureFlowAction =
  | { type: "select-frame"; frameKey: string }
  | { type: "start-capture" }
  | {
      type: "capture-complete";
      candidate: ReviewCandidate;
      reviewEnabled: boolean;
    }
  | { type: "more-time"; candidateId: string }
  | { type: "retake"; candidateId: string }
  | { type: "accept"; candidateId: string }
  | { type: "accept-failed"; candidateId: string; error: string }
  | { type: "enqueue-succeeded"; candidateId: string }
  | { type: "handoff-complete" };

export const INITIAL_CAPTURE_FLOW_STATE: CaptureFlowState = {
  phase: "picker",
  frameKey: null,
  candidate: null,
  autoAcceptPending: false,
  error: null,
};

export function reduceCaptureFlow(
  state: CaptureFlowState,
  action: CaptureFlowAction
): CaptureFlowState {
  switch (action.type) {
    case "select-frame":
      if (state.phase !== "picker") return state;
      return {
        phase: "ready",
        frameKey: action.frameKey,
        candidate: null,
        autoAcceptPending: false,
        error: null,
      };

    case "start-capture":
      if (state.phase !== "ready" || !state.frameKey) return state;
      return { ...state, phase: "capturing", error: null };

    case "capture-complete":
      if (state.phase !== "capturing") return state;
      return {
        ...state,
        phase: action.reviewEnabled ? "reviewing" : "accepting",
        candidate: action.candidate,
        autoAcceptPending: action.reviewEnabled,
        error: null,
      };

    case "more-time":
      if (!isCurrentCandidate(state, action.candidateId, "reviewing")) {
        return state;
      }
      if (!state.autoAcceptPending) return state;
      return { ...state, autoAcceptPending: false };

    case "retake":
      if (!isCurrentCandidate(state, action.candidateId, "reviewing")) {
        return state;
      }
      return {
        phase: "ready",
        frameKey: state.frameKey,
        candidate: null,
        autoAcceptPending: false,
        error: null,
      };

    case "accept":
      if (!isCurrentCandidate(state, action.candidateId, "reviewing")) {
        return state;
      }
      return {
        ...state,
        phase: "accepting",
        autoAcceptPending: false,
        error: null,
      };

    case "accept-failed":
      if (!isCurrentCandidate(state, action.candidateId, "accepting")) {
        return state;
      }
      return {
        ...state,
        phase: "reviewing",
        autoAcceptPending: false,
        error: action.error,
      };

    case "enqueue-succeeded":
      if (!isCurrentCandidate(state, action.candidateId, "accepting")) {
        return state;
      }
      return {
        phase: "handoff",
        frameKey: null,
        candidate: null,
        autoAcceptPending: false,
        error: null,
      };

    case "handoff-complete":
      if (state.phase !== "handoff") return state;
      return INITIAL_CAPTURE_FLOW_STATE;
  }
}

function isCurrentCandidate(
  state: CaptureFlowState,
  candidateId: string,
  phase: "reviewing" | "accepting"
): boolean {
  return (
    state.phase === phase
    && state.candidate?.id === candidateId
  );
}
