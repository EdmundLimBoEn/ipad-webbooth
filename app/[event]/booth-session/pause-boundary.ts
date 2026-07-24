export type BoothPauseBoundaryDependencies = {
  clearFrame: () => void;
  stopCamera: () => void;
  startCamera: () => void;
};

/**
 * Latches an observed pause until the current capture/handoff reaches a safe
 * boundary. A quick server resume cannot bypass stopping the old camera first.
 */
export class BoothPauseBoundary {
  private paused = false;
  private operationActive = false;
  private boundaryRequired = false;

  constructor(private readonly deps: BoothPauseBoundaryDependencies) {}

  beginOperation(): boolean {
    if (this.paused || this.operationActive) return false;
    this.operationActive = true;
    return true;
  }

  observe(paused: boolean): void {
    const wasPaused = this.paused;
    this.paused = paused;

    if (paused) {
      if (this.operationActive) {
        this.boundaryRequired = true;
        return;
      }
      if (!wasPaused) {
        this.deps.clearFrame();
        this.deps.stopCamera();
      }
      return;
    }

    if (wasPaused && !this.operationActive) this.deps.startCamera();
  }

  completeOperation(): boolean {
    if (!this.operationActive) return false;
    this.operationActive = false;
    if (!this.boundaryRequired) return false;

    this.boundaryRequired = false;
    this.deps.clearFrame();
    this.deps.stopCamera();
    if (!this.paused) this.deps.startCamera();
    return true;
  }

  reset(): void {
    this.paused = false;
    this.operationActive = false;
    this.boundaryRequired = false;
  }
}
