import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { EventStore, InMemoryObjectStore } from "@/app/event-store";
import { hashBoothKey } from "@/app/upload-auth";
import {
  getRehearsal,
  postRehearsal,
  postRehearsalEvidence,
  postRehearsalJoin,
  type RehearsalHandlerDeps,
} from "./handlers";

const ADMIN_KEY = "admin-key";
const BOOTH_KEY = "booth-key";
const REHEARSAL_ID = "018f0000-0000-4000-8000-000000000501";
const EVIDENCE_ID = "018f0000-0000-4000-8000-000000000502";
const CAPTURE_ID = "018f0000-0000-4000-8000-000000000503";
const BOOT_ID = "018f0000-0000-4000-8000-000000000504";

function deps(options: { adminKey?: string } = { adminKey: ADMIN_KEY }): RehearsalHandlerDeps {
  return {
    store: new EventStore(
      new InMemoryObjectStore(),
      new InMemoryObjectStore(),
      "https://photos.example",
      () => new Date("2026-07-24T00:00:00.000Z"),
    ),
    adminKey: options.adminKey,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    key?: string;
    body?: unknown;
  } = {},
): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.key ? { "x-booth-key": options.key } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const failureEvidence = {
  version: 1 as const,
  id: EVIDENCE_ID,
  rehearsalId: REHEARSAL_ID,
  observedAt: 1_753_315_200_000,
  kind: "network-failure" as const,
  captureId: CAPTURE_ID,
  bootId: BOOT_ID,
  errorClass: "network" as const,
};

describe("rehearsal handlers", () => {
  test("starts and reads only with Admin auth, failing closed without its secret", async () => {
    const context = deps();
    const denied = await postRehearsal(request("/api/rehearsals?event=launch", {
      method: "POST",
      body: { rehearsalId: REHEARSAL_ID },
    }), context);
    expect(denied.status).toBe(401);

    const started = await postRehearsal(request("/api/rehearsals?event=launch", {
      method: "POST",
      key: ADMIN_KEY,
      body: { rehearsalId: REHEARSAL_ID },
    }), context);
    expect(started.status).toBe(200);
    expect(started.headers.get("Cache-Control")).toBe("no-store");
    expect(await started.json()).toMatchObject({
      rehearsal: {
        id: REHEARSAL_ID,
        configRevisionId: null,
        frames: [],
      },
      serverTime: "2026-07-24T00:00:00.000Z",
    });

    const read = await getRehearsal(request(
      `/api/rehearsals?event=launch&id=${REHEARSAL_ID}`,
      { key: ADMIN_KEY },
    ), context);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      rehearsal: {
        session: { id: REHEARSAL_ID },
        evidence: [],
        summary: { status: "active", stale: false },
      },
    });

    const disabled = await postRehearsal(request("/api/rehearsals?event=launch", {
      method: "POST",
      key: ADMIN_KEY,
      body: { rehearsalId: REHEARSAL_ID },
    }), deps({ adminKey: undefined }));
    expect(disabled.status).toBe(503);
  });

  test("rejects canonical aliases and missing sessions", async () => {
    const context = deps();
    const alias = await postRehearsal(request("/api/rehearsals?event=Launch", {
      method: "POST",
      key: ADMIN_KEY,
      body: { rehearsalId: REHEARSAL_ID },
    }), context);
    expect(alias.status).toBe(400);

    const missing = await getRehearsal(request(
      `/api/rehearsals?event=launch&id=${REHEARSAL_ID}`,
      { key: ADMIN_KEY },
    ), context);
    expect(missing.status).toBe(404);
  });

  test("returns an allowlisted stale Booth join for matching Booth or Admin auth", async () => {
    const context = deps();
    const first = await context.store.saveConfigRevision("launch", {
      config: {
        frames: ["square"],
        boothKeyHash: await hashBoothKey(BOOTH_KEY),
      },
      baseRevisionId: null,
      mutationId: "018f0000-0000-4000-8000-000000000510",
      boothKeyMutationFingerprint: "a".repeat(64),
    });
    await context.store.startRehearsal("launch", { rehearsalId: REHEARSAL_ID });
    await context.store.saveConfigRevision("launch", {
      config: { frames: ["strip"] },
      baseRevisionId: first.revision.id,
      mutationId: "018f0000-0000-4000-8000-000000000511",
    });

    const joined = await postRehearsalJoin(request("/api/rehearsals/join?event=launch", {
      method: "POST",
      key: BOOTH_KEY,
      body: { rehearsalId: REHEARSAL_ID },
    }), context);
    expect(joined.status).toBe(200);
    const body = await joined.json();
    expect(body).toEqual({
      rehearsal: {
        id: REHEARSAL_ID,
        startedAt: "2026-07-24T00:00:00.000Z",
        configRevisionId: first.revision.id,
        frames: ["square"],
        stale: true,
      },
      serverTime: "2026-07-24T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("boothKey");
    expect(JSON.stringify(body)).not.toContain("events/launch/rehearsals");
  });

  test("allows Booth operational evidence but reserves dispositions and manual checks for Admin", async () => {
    const context = deps();
    await context.store.writeConfig("launch", {
      frames: ["square"],
      boothKeyHash: await hashBoothKey(BOOTH_KEY),
    });
    await context.store.startRehearsal("launch", { rehearsalId: REHEARSAL_ID });

    const boothRecord = await postRehearsalEvidence(request(
      `/api/rehearsals/evidence?event=launch&id=${REHEARSAL_ID}`,
      { method: "POST", key: BOOTH_KEY, body: failureEvidence },
    ), context);
    expect(boothRecord.status).toBe(200);

    const denied = await postRehearsalEvidence(request(
      `/api/rehearsals/evidence?event=launch&id=${REHEARSAL_ID}`,
      {
        method: "POST",
        key: BOOTH_KEY,
        body: {
          version: 1,
          id: "018f0000-0000-4000-8000-000000000505",
          rehearsalId: REHEARSAL_ID,
          observedAt: 1_753_315_200_001,
          kind: "manual-check",
          check: "power",
        },
      },
    ), context);
    expect(denied.status).toBe(403);

    const admin = await postRehearsalEvidence(request(
      `/api/rehearsals/evidence?event=launch&id=${REHEARSAL_ID}`,
      {
        method: "POST",
        key: ADMIN_KEY,
        body: {
          version: 1,
          id: "018f0000-0000-4000-8000-000000000505",
          rehearsalId: REHEARSAL_ID,
          observedAt: 1_753_315_200_001,
          kind: "manual-check",
          check: "power",
        },
      },
    ), context);
    expect(admin.status).toBe(200);
  });

  test("rejects expanded evidence before any append and never accepts client upload acknowledgements", async () => {
    const context = deps();
    await context.store.startRehearsal("launch", { rehearsalId: REHEARSAL_ID });
    const expanded = await postRehearsalEvidence(request(
      `/api/rehearsals/evidence?event=launch&id=${REHEARSAL_ID}`,
      {
        method: "POST",
        key: ADMIN_KEY,
        body: { ...failureEvidence, error: "private diagnostic" },
      },
    ), context);
    expect(expanded.status).toBe(400);

    const fakeAck = await postRehearsalEvidence(request(
      `/api/rehearsals/evidence?event=launch&id=${REHEARSAL_ID}`,
      {
        method: "POST",
        key: ADMIN_KEY,
        body: {
          version: 1,
          id: `upload-${CAPTURE_ID}`,
          rehearsalId: REHEARSAL_ID,
          observedAt: 1_753_315_200_000,
          kind: "photo-acknowledged",
          captureId: CAPTURE_ID,
          capturedAt: 1_753_315_200_000,
          photoKey: `launch/1753315200000-${CAPTURE_ID}.jpg`,
        },
      },
    ), context);
    expect(fakeAck.status).toBe(400);
    expect((await context.store.readRehearsal("launch", REHEARSAL_ID)).evidence)
      .toEqual([]);
  });
});
