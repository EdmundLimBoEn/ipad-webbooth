import { describe, expect, test } from "bun:test";
import { CountdownToneController } from "./countdown-audio";

function audioHarness() {
  const starts: number[] = [];
  const frequencies: number[] = [];
  let resumes = 0;
  let closes = 0;
  const context = {
    state: "suspended",
    currentTime: 10,
    destination: {},
    resume: async () => {
      resumes++;
      context.state = "running";
    },
    close: async () => {
      closes++;
      context.state = "closed";
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    }),
    createOscillator: () => ({
      frequency: {
        setValueAtTime: (frequency: number) => frequencies.push(frequency),
      },
      connect: () => {},
      start: (at: number) => starts.push(at),
      stop: () => {},
    }),
  };
  return { context, starts, frequencies, resumes: () => resumes, closes: () => closes };
}

describe("CountdownToneController", () => {
  test("does nothing until activation is explicitly requested by a caller gesture", () => {
    const harness = audioHarness();
    const tones = new CountdownToneController(() => harness.context as unknown as AudioContext);

    tones.tick(3);
    tones.captured();

    expect(harness.starts).toEqual([]);
    expect(harness.resumes()).toBe(0);
  });

  test("activation resumes audio and enables bounded countdown and capture tones", async () => {
    const harness = audioHarness();
    const tones = new CountdownToneController(() => harness.context as unknown as AudioContext);

    expect(await tones.activate()).toBe(true);
    tones.tick(Number.NaN);
    tones.tick(0);
    tones.tick(4);
    tones.tick(3);
    tones.captured();

    expect(harness.resumes()).toBe(1);
    expect(harness.starts).toHaveLength(2);
    expect(harness.frequencies.every((frequency) => frequency >= 200 && frequency <= 2_000)).toBe(true);
  });

  test("unsupported or denied audio degrades silently", async () => {
    const unsupported = new CountdownToneController(() => null);
    const denied = new CountdownToneController(() => {
      throw new DOMException("denied", "NotAllowedError");
    });

    await expect(unsupported.activate()).resolves.toBe(false);
    await expect(denied.activate()).resolves.toBe(false);
    expect(() => {
      unsupported.tick(3);
      denied.captured();
    }).not.toThrow();
  });

  test("dispose closes the context and permanently releases it", async () => {
    const harness = audioHarness();
    const tones = new CountdownToneController(() => harness.context as unknown as AudioContext);
    await tones.activate();

    await tones.dispose();
    tones.tick(2);

    expect(harness.closes()).toBe(1);
    expect(harness.starts).toEqual([]);
    await expect(tones.activate()).resolves.toBe(false);
  });
});
