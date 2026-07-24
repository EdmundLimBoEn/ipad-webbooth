export type BoothAccessState =
  | "locked"
  | "checking"
  | "ready"
  | "recovery-only"
  | "unavailable"
  | "exited";

export type BoothAccessEvent =
  | { type: "check" }
  | { type: "preflight-ready" }
  | { type: "preflight-network-failed" }
  | { type: "preflight-unavailable"; status: 409 | 503 }
  | { type: "retry" }
  | { type: "unauthorized" }
  | { type: "exit" };

export function transitionBoothAccess(
  state: BoothAccessState,
  event: BoothAccessEvent
): BoothAccessState {
  if (state === "exited") return state;
  if (event.type === "exit") return "exited";
  if (event.type === "unauthorized") return "locked";

  if (event.type === "check") {
    return state === "locked" ? "checking" : state;
  }
  if (event.type === "retry") {
    return state === "recovery-only" || state === "unavailable"
      ? "checking"
      : state;
  }
  if (state !== "checking") return state;

  if (event.type === "preflight-ready") return "ready";
  if (event.type === "preflight-network-failed") return "recovery-only";
  if (event.type === "preflight-unavailable") return "unavailable";
  return state;
}
