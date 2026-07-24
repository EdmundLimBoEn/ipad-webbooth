import { describe, expect, test } from "bun:test";
import {
  createRehearsalEvidenceOutbox,
  MemoryRehearsalEvidenceOutbox,
  type PendingRehearsalEvidence,
} from "./rehearsal-evidence-outbox";

const rehearsalA = "018f0000-0000-4000-8000-000000000501";
const rehearsalB = "018f0000-0000-4000-8000-000000000502";

function row(id: string, event: string, rehearsalId: string, createdAt: number): PendingRehearsalEvidence {
  return {
    id,
    event,
    rehearsalId,
    createdAt,
    attempts: 2,
    evidence: {
      version: 1,
      id,
      rehearsalId,
      observedAt: createdAt,
      kind: "abandoned",
    },
  };
}

describe("rehearsal evidence outbox", () => {
  test("orders rows and isolates exact Event and rehearsal identities", async () => {
    const store = new MemoryRehearsalEvidenceOutbox();
    await store.put(row("018f0000-0000-4000-8000-000000000513", "launch", rehearsalA, 1_753_315_200_003));
    await store.put(row("018f0000-0000-4000-8000-000000000511", "launch", rehearsalA, 1_753_315_200_001));
    await store.put(row("018f0000-0000-4000-8000-000000000512", "other", rehearsalA, 1_753_315_200_002));
    await store.put(row("018f0000-0000-4000-8000-000000000514", "launch", rehearsalB, 1_753_315_200_004));

    expect((await store.list("launch", rehearsalA)).map(({ id, attempts }) => [id, attempts]))
      .toEqual([
        ["018f0000-0000-4000-8000-000000000511", 2],
        ["018f0000-0000-4000-8000-000000000513", 2],
      ]);
    await store.remove("018f0000-0000-4000-8000-000000000511");
    expect((await store.list("launch", rehearsalA)).map(({ id }) => id))
      .toEqual(["018f0000-0000-4000-8000-000000000513"]);
    expect(store.isDurable()).toBeFalse();
  });

  test("opens only the separate rehearsal database and visibly degrades on failure", async () => {
    const opens: Array<[string, number | undefined]> = [];
    const factory = {
      open(name: string, version?: number) {
        opens.push([name, version]);
        const request = {
          error: new DOMException("denied"),
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null as null | (() => void),
          onblocked: null,
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    } as unknown as IDBFactory;
    const store = createRehearsalEvidenceOutbox(factory);
    await store.put(row("018f0000-0000-4000-8000-000000000511", "launch", rehearsalA, 1_753_315_200_001));

    expect(opens).toEqual([["ipad-webbooth-rehearsal", 1]]);
    expect(opens.flat().join(" ")).not.toContain("photo-outbox");
    expect(store.isDurable()).toBeFalse();
    expect(await store.list("launch", rehearsalA)).toHaveLength(1);
  });
});
