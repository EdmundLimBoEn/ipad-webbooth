export type ReviewChoice = "accept" | "retake";

export interface ReviewClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_REVIEW_CLOCK: ReviewClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ReviewDecisionGate {
  private status: "open" | "decided" | "cancelled" = "open";
  private started = false;
  private automaticAcceptanceAvailable = true;
  private timer: { handle: unknown } | null = null;

  constructor(
    private readonly autoAcceptSeconds: number,
    private readonly onDecision: (choice: ReviewChoice) => void,
    private readonly clock: ReviewClock = SYSTEM_REVIEW_CLOCK
  ) {}

  start(): void {
    if (this.status !== "open" || this.started) return;
    this.started = true;
    const handle = this.clock.setTimeout(
      () => {
        if (this.automaticAcceptanceAvailable) this.decide("accept");
      },
      Math.max(0, this.autoAcceptSeconds * 1_000)
    );
    this.timer = { handle };
  }

  accept(): boolean {
    return this.decide("accept");
  }

  retake(): boolean {
    return this.decide("retake");
  }

  moreTime(): boolean {
    if (this.status !== "open" || !this.timer) return false;
    this.automaticAcceptanceAvailable = false;
    this.clearTimer();
    return true;
  }

  cancel(): void {
    if (this.status !== "open") return;
    this.status = "cancelled";
    this.automaticAcceptanceAvailable = false;
    this.clearTimer();
  }

  private decide(choice: ReviewChoice): boolean {
    if (this.status !== "open") return false;
    this.status = "decided";
    this.clearTimer();
    this.onDecision(choice);
    return true;
  }

  private clearTimer(): void {
    const timer = this.timer;
    this.timer = null;
    if (timer) this.clock.clearTimeout(timer.handle);
  }
}
