type AudioContextFactory = () => AudioContext | null;

function defaultAudioContextFactory(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor =
    window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

export class CountdownToneController {
  private context: AudioContext | null = null;
  private active = false;
  private disposed = false;

  constructor(
    private readonly createContext: AudioContextFactory = defaultAudioContextFactory,
  ) {}

  async activate(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      this.context ??= this.createContext();
      if (!this.context) return false;
      if (this.context.state === "suspended") await this.context.resume();
      this.active = this.context.state === "running";
      return this.active;
    } catch {
      const context = this.context;
      this.active = false;
      if (context && context.state !== "closed") {
        try {
          await context.close();
        } catch {
          // Audio is optional; cleanup failure must not block the booth.
        }
      }
      if (this.context === context) this.context = null;
      return false;
    }
  }

  tick(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > 3) return;
    this.play(520 + (3 - count) * 90, 0.08);
  }

  captured(): void {
    this.play(1_040, 0.13);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    const context = this.context;
    this.context = null;
    if (!context || context.state === "closed") return;
    try {
      await context.close();
    } catch {
      // Optional feedback must never interfere with capture cleanup.
    }
  }

  private play(frequency: number, duration: number): void {
    const context = this.context;
    if (!this.active || !context || context.state !== "running") return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.11, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    } catch {
      // Audio is progressive enhancement; visual countdown remains authoritative.
    }
  }
}
