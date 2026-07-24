import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  eventConfigMutationKey,
} from "@/app/event-store";
import {
  boothKeyMutationFingerprint,
  getConfigRevisions,
  getPublicConfig,
  postConfigRestore,
  putConfig,
  type ConfigHandlerDeps,
} from "./handlers";

const ADMIN_KEY = "admin-secret";
const FIRST_ID = "018f0000-0000-7000-8000-000000000020";
const SECOND_ID = "018f0000-0000-7000-8000-000000000021";
const THIRD_ID = "018f0000-0000-7000-8000-000000000022";
const BOOTH_KEY = "123456789012";

function deps(options: { adminKey?: string; hashBoothKey?: (key: string) => Promise<string> } = {}) {
  const state = new InMemoryObjectStore();
  const store = new EventStore(
    new InMemoryObjectStore(),
    state,
    "https://photos.example",
    () => new Date("2026-07-24T00:00:00.000Z")
  );
  return {
    state,
    deps: {
      store,
      adminKey: "adminKey" in options ? options.adminKey : ADMIN_KEY,
      hashBoothKey: options.hashBoothKey ?? (async (key: string) => `hashed:${key}`),
    } satisfies ConfigHandlerDeps,
  };
}

const request = (
  url: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {}
) => new NextRequest(url, init);

function adminRequest(
  path: string,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
  key = ADMIN_KEY
) {
  return request(`https://app.test${path}`, {
    method,
    headers: {
      "x-booth-key": key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function saveBody(overrides: Record<string, unknown> = {}) {
  return {
    frames: ["square"],
    mutationId: FIRST_ID,
    baseRevisionId: null,
    ...overrides,
  };
}

function credentialFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => credentialFields(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(["boothKey", "boothKeyHash", "boothKeyMutationFingerprint"].includes(key)
      ? [`${path}.${key}`]
      : []),
    ...credentialFields(item, `${path}.${key}`),
  ]);
}

describe("boothKeyMutationFingerprint", () => {
  test("is a stable lowercase HMAC-SHA256 keyed by the Admin Key", async () => {
    const expected = createHmac("sha256", ADMIN_KEY).update(BOOTH_KEY).digest("hex");
    const first = await boothKeyMutationFingerprint(BOOTH_KEY, ADMIN_KEY);
    const retry = await boothKeyMutationFingerprint(BOOTH_KEY, ADMIN_KEY);

    expect(first).toBe(expected);
    expect(retry).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(createHash("sha256").update(BOOTH_KEY).digest("hex"));
  });

  test("changes for a different plaintext or Admin Key", async () => {
    const original = await boothKeyMutationFingerprint(BOOTH_KEY, ADMIN_KEY);

    expect(await boothKeyMutationFingerprint(`${BOOTH_KEY}x`, ADMIN_KEY)).not.toBe(original);
    expect(await boothKeyMutationFingerprint(BOOTH_KEY, "different-admin")).not.toBe(original);
  });
});

describe("config handlers", () => {
  test("public config is explicitly redacted", async () => {
    const d = deps();
    await d.deps.store.writeConfig("launch", {
      frames: ["square"],
      boothKeyHash: "private-hash",
    });

    const response = await getPublicConfig(
      request("https://app.test/api/config?event=launch"),
      d.deps
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ frames: ["square"], hasBoothKey: true });
    expect(credentialFields(json)).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("private-hash");
  });

  test("public config preserves the unsaved compatibility projection", async () => {
    const d = deps();
    const response = await getPublicConfig(
      request("https://app.test/api/config?event=launch"),
      d.deps
    );

    expect(await response.json()).toEqual({ frames: null, hasBoothKey: false });
  });

  test("save requires canonical Event, Admin Key, mutation, and base", async () => {
    const d = deps();
    const response = await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ boothKey: BOOTH_KEY })
      ),
      d.deps
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      frames: ["square"],
      hasBoothKey: true,
      currentRevisionId: FIRST_ID,
      idempotent: false,
    });
    expect(credentialFields(json)).toEqual([]);
    expect(JSON.stringify(json)).not.toContain(BOOTH_KEY);
  });

  test("save stores an opaque fingerprint privately with the independently hashed key", async () => {
    const d = deps({ hashBoothKey: async () => "salted-pbkdf2-hash" });
    await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ boothKey: BOOTH_KEY })
      ),
      d.deps
    );

    expect((await d.deps.store.readConfig("launch"))?.boothKeyHash).toBe("salted-pbkdf2-hash");
    const intent = await d.state.get(eventConfigMutationKey("launch", FIRST_ID));
    const text = await intent?.text();
    const json = JSON.parse(text ?? "{}") as Record<string, unknown>;
    expect(json.boothKeyMutationFingerprint).toBe(
      await boothKeyMutationFingerprint(BOOTH_KEY, ADMIN_KEY)
    );
    expect(text).not.toContain(BOOTH_KEY);
    expect(text).not.toContain("salted-pbkdf2-hash");
  });

  test("same plaintext mutation retries despite fresh salted hashes", async () => {
    let hashes = 0;
    const d = deps({ hashBoothKey: async () => `salted-hash-${++hashes}` });
    const req = () => adminRequest(
      "/api/config?event=launch",
      "PUT",
      saveBody({ boothKey: BOOTH_KEY })
    );

    expect((await putConfig(req(), d.deps)).status).toBe(200);
    const response = await putConfig(req(), d.deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotent: true });
    expect(hashes).toBe(2);
    expect((await d.deps.store.readConfig("launch"))?.boothKeyHash).toBe("salted-hash-1");
  });

  test("different Booth key plaintext under one mutation conflicts", async () => {
    const d = deps();
    expect((await putConfig(
      adminRequest("/api/config?event=launch", "PUT", saveBody({ boothKey: BOOTH_KEY })),
      d.deps
    )).status).toBe(200);

    const response = await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ boothKey: "different-key-123" })
      ),
      d.deps
    );

    expect(response.status).toBe(409);
  });

  test("save rejects unavailable and incorrect Admin Keys", async () => {
    const disabled = deps({ adminKey: undefined });
    const unauthorized = deps();

    expect((await putConfig(
      adminRequest("/api/config?event=launch", "PUT", saveBody()),
      disabled.deps
    )).status).toBe(503);
    expect((await putConfig(
      adminRequest("/api/config?event=launch", "PUT", saveBody(), "wrong-key"),
      unauthorized.deps
    )).status).toBe(401);
  });

  test("save rejects malformed bodies, unknown Frames, and invalid Booth keys", async () => {
    const invalidBodies = [
      null,
      {},
      saveBody({ frames: "square" }),
      saveBody({ frames: ["not-a-frame"] }),
      saveBody({ boothKey: "too-short" }),
      saveBody({ boothKey: "x".repeat(129) }),
      saveBody({ mutationId: "not-a-revision" }),
      { frames: ["square"], mutationId: FIRST_ID },
      saveBody({ baseRevisionId: "not-a-revision" }),
    ];

    for (const body of invalidBodies) {
      const d = deps();
      const response = await putConfig(
        adminRequest("/api/config?event=launch", "PUT", body),
        d.deps
      );
      expect(response.status).toBe(400);
    }

    const d = deps();
    const malformed = await putConfig(
      request("https://app.test/api/config?event=launch", {
        method: "PUT",
        headers: {
          "x-booth-key": ADMIN_KEY,
          "content-type": "application/json",
        },
        body: "{",
      }),
      d.deps
    );
    expect(malformed.status).toBe(400);
  });

  test("save rejects inherited object names as Frames without writing config", async () => {
    for (const frame of ["constructor", "toString"]) {
      const d = deps();
      const response = await putConfig(
        adminRequest(
          "/api/config?event=launch",
          "PUT",
          saveBody({ frames: [frame] })
        ),
        d.deps
      );

      expect(response.status).toBe(400);
      expect(await d.deps.store.readConfig("launch")).toBeNull();
    }
  });

  test("save maps stale bases and mutation reuse to conflict", async () => {
    const d = deps();
    expect((await putConfig(
      adminRequest("/api/config?event=launch", "PUT", saveBody()),
      d.deps
    )).status).toBe(200);

    expect((await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ mutationId: SECOND_ID, baseRevisionId: null })
      ),
      d.deps
    )).status).toBe(409);
    expect((await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ frames: ["birthday"] })
      ),
      d.deps
    )).status).toBe(409);
  });

  test("all config handlers reject Event aliases rather than slugging them", async () => {
    const d = deps();
    const responses = await Promise.all([
      getPublicConfig(request("https://app.test/api/config?event=Launch%20Party"), d.deps),
      putConfig(
        adminRequest("/api/config?event=Launch%20Party", "PUT", saveBody()),
        d.deps
      ),
      getConfigRevisions(
        adminRequest("/api/config/revisions?event=Launch%20Party", "GET"),
        d.deps
      ),
      postConfigRestore(
        adminRequest("/api/config/revisions/restore?event=Launch%20Party", "POST", {
          revisionId: FIRST_ID,
          mutationId: SECOND_ID,
          baseRevisionId: FIRST_ID,
        }),
        d.deps
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  });

  test("history is Admin-only and returns reachable redacted revisions", async () => {
    const d = deps();
    await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ boothKey: BOOTH_KEY })
      ),
      d.deps
    );
    await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({
          frames: ["birthday"],
          mutationId: SECOND_ID,
          baseRevisionId: FIRST_ID,
        })
      ),
      d.deps
    );

    expect((await getConfigRevisions(
      request("https://app.test/api/config/revisions?event=launch"),
      d.deps
    )).status).toBe(401);

    const response = await getConfigRevisions(
      adminRequest("/api/config/revisions?event=launch", "GET"),
      d.deps
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      config: { frames: ["birthday"], hasBoothKey: true },
      currentRevisionId: SECOND_ID,
    });
    expect(json.revisions.map((revision: { id: string }) => revision.id)).toEqual([
      SECOND_ID,
      FIRST_ID,
    ]);
    expect(credentialFields(json)).toEqual([]);
    expect(JSON.stringify(json)).not.toContain(BOOTH_KEY);
    expect(JSON.stringify(json)).not.toContain("hashed:");
  });

  test("history returns 503 when the Admin Key is unavailable", async () => {
    const d = deps({ adminKey: undefined });
    const response = await getConfigRevisions(
      adminRequest("/api/config/revisions?event=launch", "GET"),
      d.deps
    );

    expect(response.status).toBe(503);
  });

  test("restore appends the selected reachable revision and preserves the Booth key", async () => {
    const d = deps();
    await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({ boothKey: BOOTH_KEY })
      ),
      d.deps
    );
    await putConfig(
      adminRequest(
        "/api/config?event=launch",
        "PUT",
        saveBody({
          frames: ["birthday"],
          mutationId: SECOND_ID,
          baseRevisionId: FIRST_ID,
        })
      ),
      d.deps
    );

    const restore = () => postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: FIRST_ID,
        mutationId: THIRD_ID,
        baseRevisionId: SECOND_ID,
      }),
      d.deps
    );
    const response = await restore();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      frames: ["square"],
      hasBoothKey: true,
      currentRevisionId: THIRD_ID,
      idempotent: false,
    });
    expect(credentialFields(json)).toEqual([]);
    const retry = await restore();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotent: true });
  });

  test("restore maps a missing source to 404 and stale or reused mutations to 409", async () => {
    const d = deps();
    await putConfig(
      adminRequest("/api/config?event=launch", "PUT", saveBody()),
      d.deps
    );

    expect((await postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: SECOND_ID,
        mutationId: THIRD_ID,
        baseRevisionId: FIRST_ID,
      }),
      d.deps
    )).status).toBe(404);
    expect((await postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: FIRST_ID,
        mutationId: SECOND_ID,
        baseRevisionId: null,
      }),
      d.deps
    )).status).toBe(409);
    expect((await postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: FIRST_ID,
        mutationId: FIRST_ID,
        baseRevisionId: FIRST_ID,
      }),
      d.deps
    )).status).toBe(409);
  });

  test("restore rejects malformed input and enforces Admin authentication", async () => {
    const invalidBodies = [
      null,
      {},
      { revisionId: "bad", mutationId: SECOND_ID, baseRevisionId: FIRST_ID },
      { revisionId: FIRST_ID, mutationId: "bad", baseRevisionId: FIRST_ID },
      { revisionId: FIRST_ID, mutationId: SECOND_ID },
      { revisionId: FIRST_ID, mutationId: SECOND_ID, baseRevisionId: "bad" },
    ];

    for (const body of invalidBodies) {
      const d = deps();
      expect((await postConfigRestore(
        adminRequest("/api/config/revisions/restore?event=launch", "POST", body),
        d.deps
      )).status).toBe(400);
    }

    const unauthorized = deps();
    expect((await postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: FIRST_ID,
        mutationId: SECOND_ID,
        baseRevisionId: FIRST_ID,
      }, "wrong"),
      unauthorized.deps
    )).status).toBe(401);

    const disabled = deps({ adminKey: undefined });
    expect((await postConfigRestore(
      adminRequest("/api/config/revisions/restore?event=launch", "POST", {
        revisionId: FIRST_ID,
        mutationId: SECOND_ID,
        baseRevisionId: FIRST_ID,
      }),
      disabled.deps
    )).status).toBe(503);
  });
});
