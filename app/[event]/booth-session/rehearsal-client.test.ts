import { expect, test } from "bun:test";
import type { OutboxItem } from "./outbox";
import { RehearsalClient } from "./rehearsal-client";
import { MemoryRehearsalEvidenceOutbox } from "./rehearsal-evidence-outbox";

const rehearsalId = "018f0000-0000-4000-8000-000000000501";
const ids = Array.from({ length: 20 }, (_, index) =>
  `018f0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);

test("joins before evidence and persists only network-class failures for exact rehearsal rows", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let next = 0;
  const outbox = new MemoryRehearsalEvidenceOutbox();
  const client = new RehearsalClient({
    event: "launch",
    rehearsalId,
    key: () => "booth-key",
    outbox,
    makeId: () => ids[next++],
    now: () => 1_753_315_200_000 + next,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/join")) {
        return Response.json({
          rehearsal: {
            version: 1,
            id: rehearsalId,
            startedAt: "2026-07-24T00:00:00.000Z",
            configRevisionId: null,
            frames: ["square"],
            stale: false,
          },
        });
      }
      throw new Error("offline");
    },
  });
  const item: OutboxItem = {
    id: ids[15],
    event: "launch",
    blob: new Blob(["photo"]),
    createdAt: 1_753_315_200_000,
    attempts: 1,
    rehearsalId,
  };

  await client.join();
  await client.recordUploadFailure(item, { kind: "retryable", errorClass: "network" });
  await client.recordUploadFailure({ ...item, id: ids[16], rehearsalId: undefined }, { kind: "retryable", errorClass: "timeout" });
  await client.recordUploadFailure({ ...item, id: ids[17] }, { kind: "auth", errorClass: "auth" });
  const rows = await outbox.list("launch", rehearsalId);

  expect(calls[0].url).toContain("/join");
  expect(rows).toHaveLength(1);
  expect(rows[0].attempts).toBe(1);
  expect(rows[0].evidence).toMatchObject({
    kind: "network-failure",
    captureId: ids[15],
    errorClass: "network",
  });
});

test("tags only active non-stale captures and records exact recovered order", async () => {
  let next = 0;
  const bodies: unknown[] = [];
  const client = new RehearsalClient({
    event: "launch",
    rehearsalId,
    key: () => "booth-key",
    previousBootId: ids[18],
    makeId: () => ids[next++],
    now: () => 1_753_315_200_000 + next,
    fetch: async (input, init) => {
      if (String(input).includes("/join")) {
        return Response.json({
          rehearsal: {
            version: 1,
            id: rehearsalId,
            startedAt: "2026-07-24T00:00:00.000Z",
            configRevisionId: null,
            frames: [],
            stale: false,
          },
        });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ idempotent: false });
    },
  });
  await client.join();
  expect(client.rehearsalIdForNewCapture()).toBe(rehearsalId);
  await client.recordRecovery([
    { id: ids[15], event: "launch", blob: new Blob(), createdAt: 1, attempts: 0, rehearsalId },
    { id: ids[16], event: "launch", blob: new Blob(), createdAt: 2, attempts: 0, rehearsalId },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.stop();

  expect(client.rehearsalIdForNewCapture()).toBeUndefined();
  expect(bodies).toContainEqual(expect.objectContaining({
    kind: "outbox-recovered",
    previousBootId: ids[18],
    captureIds: [ids[15], ids[16]],
  }));
});
