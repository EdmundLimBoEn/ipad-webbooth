import { describe, expect, test } from "bun:test";
import {
  parseRehearsalEvidence,
  parseRehearsalSession,
  reduceRehearsal,
  type RehearsalEvidence,
  type RehearsalSession,
} from "./rehearsal";

const rehearsalId = "018f0000-0000-4000-8000-000000000501";
const deviceId = "018f0000-0000-4000-8000-000000000502";
const firstBoot = "018f0000-0000-4000-8000-000000000503";
const secondBoot = "018f0000-0000-4000-8000-000000000504";
const firstCapture = "018f0000-0000-4000-8000-000000000505";
const secondCapture = "018f0000-0000-4000-8000-000000000506";
const revisionId = "018f0000-0000-4000-8000-000000000507";
type EvidenceDetails = RehearsalEvidence extends infer Evidence
  ? Evidence extends RehearsalEvidence
    ? Omit<Evidence, "version" | "id" | "rehearsalId" | "observedAt" | "recordedAt">
    : never
  : never;

const session: RehearsalSession = {
  version: 1,
  id: rehearsalId,
  startedAt: "2026-07-24T00:00:00.000Z",
  configRevisionId: revisionId,
  frames: ["square", "strip"],
};

function evidence(
  index: number,
  value: EvidenceDetails,
): RehearsalEvidence {
  return {
    version: 1,
    id: `018f0000-0000-4000-8000-${String(600 + index).padStart(12, "0")}`,
    rehearsalId,
    observedAt: 1_753_315_200_000 + index,
    recordedAt: new Date(1_753_315_200_000 + index).toISOString(),
    ...value,
  } as RehearsalEvidence;
}

describe("rehearsal schemas", () => {
  test("strictly parses sessions and rejects unsafe expansion", () => {
    expect(parseRehearsalSession(session)).toEqual(session);
    for (const invalid of [
      { ...session, id: rehearsalId.toUpperCase() },
      { ...session, frames: ["../unsafe"] },
      { ...session, boothKeyHash: "secret" },
      { ...session, version: 2 },
    ]) {
      expect(parseRehearsalSession(invalid)).toBeNull();
    }
  });

  test("strictly parses Event-owned evidence and rejects arbitrary diagnostics", () => {
    const valid = evidence(1, {
      kind: "photo-acknowledged",
      captureId: firstCapture,
      capturedAt: 1_753_315_200_000,
      frameKey: "square",
      photoKey: "launch/1753315200000-a.jpg",
    });
    expect(parseRehearsalEvidence(valid, "launch")).toEqual(valid);
    expect(parseRehearsalEvidence({ ...valid, photoKey: "other/1753315200000-a.jpg" }, "launch")).toBeNull();
    expect(parseRehearsalEvidence({ ...valid, error: "private stack" }, "launch")).toBeNull();
  });

  test("accepts deterministic server upload evidence IDs only for acknowledgements", () => {
    const acknowledged = evidence(2, {
      kind: "photo-acknowledged",
      captureId: firstCapture,
      capturedAt: 1_753_315_200_000,
      photoKey: "launch/1753315200000-a.jpg",
    });
    expect(parseRehearsalEvidence({
      ...acknowledged,
      id: `upload-${firstCapture}`,
    }, "launch")).not.toBeNull();
    expect(parseRehearsalEvidence({
      ...evidence(3, {
        kind: "network-failure",
        captureId: firstCapture,
        bootId: firstBoot,
        errorClass: "network",
      }),
      id: `upload-${firstCapture}`,
    }, "launch")).toBeNull();
  });
});

describe("rehearsal completion", () => {
  test("requires the complete ordered recovery, delivery, canary, and outbox story", () => {
    const firstKey = "launch/1753315200000-a.jpg";
    const secondKey = "launch/1753315200001-b.jpg";
    const records: RehearsalEvidence[] = [
      evidence(1, {
        kind: "booth-ready",
        deviceId,
        bootId: firstBoot,
        cameraReady: true,
        durableStorage: true,
      }),
      evidence(2, { kind: "network-failure", captureId: firstCapture, bootId: firstBoot, errorClass: "network" }),
      evidence(3, { kind: "network-failure", captureId: secondCapture, bootId: firstBoot, errorClass: "timeout" }),
      evidence(4, {
        kind: "outbox-recovered",
        previousBootId: firstBoot,
        bootId: secondBoot,
        captureIds: [firstCapture, secondCapture],
      }),
      evidence(5, {
        kind: "photo-acknowledged",
        captureId: firstCapture,
        capturedAt: 1_753_315_200_000,
        frameKey: "square",
        photoKey: firstKey,
      }),
      evidence(6, {
        kind: "photo-acknowledged",
        captureId: secondCapture,
        capturedAt: 1_753_315_200_001,
        frameKey: "strip",
        photoKey: secondKey,
      }),
      evidence(7, { kind: "ordered-drain", bootId: secondBoot, captureIds: [firstCapture, secondCapture] }),
      evidence(8, { kind: "delivery-observed", photoKey: firstKey, feedObserved: true, publicImageObserved: true }),
      evidence(9, { kind: "canary-designated", photoKey: firstKey }),
      evidence(10, { kind: "canary-deleted", photoKey: firstKey, cleanupPending: true }),
      evidence(11, { kind: "outbox-empty", bootId: secondBoot, pendingCount: 0 }),
      evidence(12, { kind: "photo-retained", photoKey: secondKey }),
      evidence(13, { kind: "manual-check", check: "power" }),
    ];
    const summary = reduceRehearsal({
      session,
      evidence: records,
      currentRevisionId: revisionId,
    });
    expect(summary.status).toBe("complete");
    expect(Object.values(summary.requirements).every(({ complete }) => complete)).toBeTrue();
    expect(summary.manualChecks.power).toBeTrue();
    expect(summary.remainingExactKeys).toEqual([]);
    expect(summary.trackedPhotos).toEqual([
      {
        captureId: firstCapture,
        frameKey: "square",
        photoKey: firstKey,
        disposition: "canary-deleted",
      },
      {
        captureId: secondCapture,
        frameKey: "strip",
        photoKey: secondKey,
        disposition: "retained",
      },
    ]);
  });

  test("does not overcount duplicates, fallback frames, mismatched recovery, or stale sessions", () => {
    const failed = evidence(1, {
      kind: "network-failure",
      captureId: firstCapture,
      bootId: firstBoot,
      errorClass: "network",
    });
    const summary = reduceRehearsal({
      session,
      evidence: [
        failed,
        { ...failed, id: "018f0000-0000-4000-8000-000000000699" },
        evidence(2, {
          kind: "outbox-recovered",
          previousBootId: firstBoot,
          bootId: firstBoot,
          captureIds: [firstCapture],
        }),
        evidence(3, {
          kind: "photo-acknowledged",
          captureId: firstCapture,
          capturedAt: 1_753_315_200_000,
          photoKey: "launch/1753315200000-a.jpg",
        }),
        evidence(4, { kind: "abandoned" }),
      ],
      currentRevisionId: null,
    });
    expect(summary.requirements["two-network-failures"].complete).toBeFalse();
    expect(summary.requirements["frames-covered"].complete).toBeFalse();
    expect(summary.requirements["reload-recovered"].complete).toBeFalse();
    expect(summary.status).toBe("abandoned");
    expect(summary.stale).toBeTrue();
    expect(summary.remainingExactKeys).toEqual(["launch/1753315200000-a.jpg"]);
  });

  test("requires each correlated proof to be recorded after its prerequisites", () => {
    const key = "launch/1753315200000-a.jpg";
    const summary = reduceRehearsal({
      session,
      evidence: [
        evidence(1, {
          kind: "outbox-recovered",
          previousBootId: firstBoot,
          bootId: secondBoot,
          captureIds: [firstCapture, secondCapture],
        }),
        evidence(2, { kind: "ordered-drain", bootId: secondBoot, captureIds: [firstCapture, secondCapture] }),
        evidence(3, { kind: "delivery-observed", photoKey: key, feedObserved: true, publicImageObserved: true }),
        evidence(4, { kind: "canary-deleted", photoKey: key, cleanupPending: true }),
        evidence(5, { kind: "network-failure", captureId: firstCapture, bootId: firstBoot, errorClass: "network" }),
        evidence(6, { kind: "network-failure", captureId: secondCapture, bootId: firstBoot, errorClass: "timeout" }),
        evidence(7, {
          kind: "photo-acknowledged",
          captureId: firstCapture,
          capturedAt: 1_753_315_200_000,
          frameKey: "square",
          photoKey: key,
        }),
        evidence(8, {
          kind: "photo-acknowledged",
          captureId: secondCapture,
          capturedAt: 1_753_315_200_001,
          frameKey: "strip",
          photoKey: "launch/1753315200001-b.jpg",
        }),
        evidence(9, { kind: "canary-designated", photoKey: key }),
      ],
      currentRevisionId: revisionId,
    });

    expect(summary.requirements["two-network-failures"].complete).toBeTrue();
    expect(summary.requirements["reload-recovered"].complete).toBeFalse();
    expect(summary.requirements["ordered-drain"].complete).toBeFalse();
    expect(summary.requirements["public-delivery"].complete).toBeFalse();
    expect(summary.requirements["canary-deleted"].complete).toBeFalse();
  });

  test("uses the latest server-recorded exact disposition for conflicting choices", () => {
    const key = "launch/1753315200000-a.jpg";
    const base = evidence(1, {
      kind: "photo-acknowledged",
      captureId: firstCapture,
      capturedAt: 1_753_315_200_000,
      photoKey: key,
    });
    const deletedLatest = reduceRehearsal({
      session,
      evidence: [
        base,
        evidence(2, { kind: "photo-retained", photoKey: key }),
        evidence(3, { kind: "photo-deleted", photoKey: key }),
      ],
      currentRevisionId: revisionId,
    });
    const retainedLatest = reduceRehearsal({
      session,
      evidence: [
        base,
        evidence(2, { kind: "photo-deleted", photoKey: key }),
        evidence(3, { kind: "photo-retained", photoKey: key }),
      ],
      currentRevisionId: revisionId,
    });

    expect(deletedLatest.trackedPhotos[0]?.disposition).toBe("deleted");
    expect(retainedLatest.trackedPhotos[0]?.disposition).toBe("retained");
  });
});
