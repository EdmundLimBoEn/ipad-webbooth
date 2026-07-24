import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  type BoothHeartbeatListOptions,
  type BoothHeartbeatPage,
} from "@/app/event-store";
import { hashBoothKey } from "@/app/upload-auth";
import {
  getBoothHeartbeats,
  getBoothState,
  postBoothHeartbeat,
  postBoothPreflight,
  putBoothState,
  type BoothControlHandlerDeps,
} from "./handlers";

const ADMIN_KEY = "admin-secret";
const BOOTH_KEY = "event-key-123";
const NOW = "2026-07-24T00:00:00.000Z";

const heartbeat = {
  version: 1,
  deviceId: "018f0000-0000-4000-8000-000000000001",
  sessionStartedAt: 1753315200000,
  pendingCount: 2,
  durableStorage: true,
  online: true,
  installed: true,
  camera: "ready",
  upload: "retry-wait",
  buildId: "release_1",
} as const;

type RequestOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

function request(path: string, init: RequestOptions = {}): NextRequest {
  const { body, headers, method } = init;
  return new NextRequest(`https://app.test${path}`, {
    ...(method ? { method } : {}),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function rawJsonRequest(
  path: string,
  method: "POST" | "PUT",
  body: string,
  key = ADMIN_KEY
): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-booth-key": key,
    },
    body,
  });
}

function controlDeps(options: { adminKey?: string } = {}) {
  const state = new InMemoryObjectStore();
  const store = new EventStore(
    new InMemoryObjectStore(),
    state,
    "https://photos.example",
    () => new Date(NOW)
  );
  return {
    state,
    deps: {
      store,
      adminKey: "adminKey" in options ? options.adminKey : ADMIN_KEY,
    } satisfies BoothControlHandlerDeps,
  };
}

async function configuredDeps() {
  const controls = controlDeps();
  await controls.deps.store.writeConfig("launch", {
    frames: ["square"],
    boothKeyHash: await hashBoothKey(BOOTH_KEY),
    currentRevisionId: "018f0000-0000-4000-8000-000000000001",
  });
  return controls;
}

class OpaqueCursorStore extends EventStore {
  receivedOptions: BoothHeartbeatListOptions | undefined;

  override async listBoothHeartbeats(
    _event: string,
    options: BoothHeartbeatListOptions = {}
  ): Promise<BoothHeartbeatPage> {
    this.receivedOptions = options;
    return { booths: [], cursor: "store-issued" };
  }
}

type QueryHandlerCase = {
  name: string;
  missingAdminRegression?: boolean;
  wrongCredentialRegression?: boolean;
  invoke: (
    query: string,
    deps: BoothControlHandlerDeps,
    key?: string
  ) => Promise<Response>;
};

const queryHandlerCases: QueryHandlerCase[] = [
  {
    name: "preflight",
    wrongCredentialRegression: true,
    invoke: (query, deps, key = ADMIN_KEY) => postBoothPreflight(request(
      `/api/booth/preflight?${query}`,
      { method: "POST", headers: { "x-booth-key": key } }
    ), deps),
  },
  {
    name: "heartbeat",
    missingAdminRegression: true,
    wrongCredentialRegression: true,
    invoke: (query, deps, key = ADMIN_KEY) => postBoothHeartbeat(request(
      `/api/booths?${query}`,
      { method: "POST", headers: { "x-booth-key": key }, body: heartbeat }
    ), deps),
  },
  {
    name: "Booth list",
    missingAdminRegression: true,
    wrongCredentialRegression: true,
    invoke: (query, deps, key = ADMIN_KEY) => getBoothHeartbeats(request(
      `/api/booths?${query}`,
      { headers: { "x-booth-key": key } }
    ), deps),
  },
  {
    name: "public pause read",
    invoke: (query, deps) => getBoothState(request(`/api/booth-state?${query}`), deps),
  },
  {
    name: "pause mutation",
    missingAdminRegression: true,
    wrongCredentialRegression: true,
    invoke: (query, deps, key = ADMIN_KEY) => putBoothState(request(
      `/api/booth-state?${query}`,
      { method: "PUT", headers: { "x-booth-key": key }, body: { paused: true } }
    ), deps),
  },
];

type JsonHandlerCase = {
  name: string;
  invoke: (req: NextRequest, deps: BoothControlHandlerDeps) => Promise<Response>;
  method: "POST" | "PUT";
  path: string;
  oversizedBody: unknown;
};

const jsonHandlerCases: JsonHandlerCase[] = [
  {
    name: "heartbeat",
    invoke: postBoothHeartbeat,
    method: "POST",
    path: "/api/booths?event=launch",
    oversizedBody: { ...heartbeat, buildId: "x".repeat(16 * 1024) },
  },
  {
    name: "pause mutation",
    invoke: putBoothState,
    method: "PUT",
    path: "/api/booth-state?event=launch",
    oversizedBody: { paused: true, messages: { en: "x".repeat(16 * 1024) } },
  },
];

describe("Booth control handlers", () => {
  for (const handlerCase of queryHandlerCases) {
    test(`${handlerCase.name} rejects duplicate and unknown query keys`, async () => {
      const controls = controlDeps();
      const queries = [
        "event=launch&event=launch",
        "event=launch&unknown=value",
      ];

      for (const query of queries) {
        expect((await handlerCase.invoke(query, controls.deps)).status).toBe(400);
      }
    });
  }

  test("Booth list rejects duplicate cursor and limit query keys", async () => {
    const controls = controlDeps();
    const queries = [
      "event=launch&cursor=first&cursor=second",
      "event=launch&limit=1&limit=100",
    ];

    for (const query of queries) {
      expect((await getBoothHeartbeats(request(`/api/booths?${query}`, {
        headers: { "x-booth-key": ADMIN_KEY },
      }), controls.deps)).status).toBe(400);
    }
  });

  for (const limit of [1, 100]) {
    test(`Booth list accepts the exact ${limit} limit boundary`, async () => {
      const store = new OpaqueCursorStore(
        new InMemoryObjectStore(),
        new InMemoryObjectStore(),
        "https://photos.example"
      );
      const response = await getBoothHeartbeats(request(
        `/api/booths?event=launch&limit=${limit}`,
        { headers: { "x-booth-key": ADMIN_KEY } }
      ), { store, adminKey: ADMIN_KEY });

      expect(response.status).toBe(200);
      expect(store.receivedOptions).toEqual({ limit });
    });
  }

  for (const limit of ["0", "101", "-1", "1.5", "01", "invalid"]) {
    test(`Booth list rejects out-of-range limit ${limit}`, async () => {
      const controls = controlDeps();
      const response = await getBoothHeartbeats(request(
        `/api/booths?event=launch&limit=${encodeURIComponent(limit)}`,
        { headers: { "x-booth-key": ADMIN_KEY } }
      ), controls.deps);

      expect(response.status).toBe(400);
    });
  }

  for (const handlerCase of jsonHandlerCases) {
    test(`${handlerCase.name} rejects malformed JSON with 400`, async () => {
      const controls = controlDeps();
      const response = await handlerCase.invoke(
        rawJsonRequest(handlerCase.path, handlerCase.method, "{"),
        controls.deps
      );

      expect(response.status).toBe(400);
    });

    test(`${handlerCase.name} rejects oversized JSON with 413`, async () => {
      const controls = controlDeps();
      const response = await handlerCase.invoke(request(handlerCase.path, {
        method: handlerCase.method,
        headers: { "x-booth-key": ADMIN_KEY },
        body: handlerCase.oversizedBody,
      }), controls.deps);

      expect(response.status).toBe(413);
    });
  }

  test("authenticated Booth handlers consistently fail closed without the Admin secret", async () => {
    const previous = process.env.ALLOW_KEYLESS;
    process.env.ALLOW_KEYLESS = "1";
    try {
      const controls = controlDeps({ adminKey: undefined });
      const cases = queryHandlerCases.filter(({ missingAdminRegression }) => missingAdminRegression);

      for (const handlerCase of cases) {
        expect((await handlerCase.invoke("event=launch", controls.deps)).status).toBe(503);
      }
    } finally {
      if (previous === undefined) delete process.env.ALLOW_KEYLESS;
      else process.env.ALLOW_KEYLESS = previous;
    }
  });

  test("authenticated Booth handlers reject wrong credentials", async () => {
    const controls = await configuredDeps();
    const cases = queryHandlerCases.filter(({ wrongCredentialRegression }) => wrongCredentialRegression);

    for (const handlerCase of cases) {
      expect((await handlerCase.invoke("event=launch", controls.deps, "wrong-key")).status).toBe(401);
    }
  });

  test("preflight accepts a matching Booth Key or the Admin Key", async () => {
    const controls = await configuredDeps();
    await controls.deps.store.writeBoothOperationalState("launch", {
      paused: true,
      messages: { en: "A brief pause" },
    });

    const booth = await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": BOOTH_KEY },
    }), controls.deps);
    const admin = await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
    }), controls.deps);

    const boothBody = await booth.json() as {
      experience: unknown;
      operationalState: unknown;
      serverTime: string;
    };
    expect(booth.status).toBe(200);
    expect(boothBody).toMatchObject({
      experience: { frames: ["square"] },
      operationalState: {
        version: 1,
        paused: true,
        messages: { en: "A brief pause" },
        updatedAt: NOW,
      },
    });
    expect(boothBody.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(admin.status).toBe(200);
  });

  test("preflight fails closed when the Admin Key is unavailable", async () => {
    const previous = process.env.ALLOW_KEYLESS;
    delete process.env.ALLOW_KEYLESS;
    try {
      const controls = controlDeps({ adminKey: undefined });
      await controls.deps.store.writeConfig("launch", {
        frames: ["square"],
        boothKeyHash: await hashBoothKey(BOOTH_KEY),
      });

      const response = await postBoothPreflight(request("/api/booth/preflight?event=launch", {
        method: "POST",
        headers: { "x-booth-key": BOOTH_KEY },
      }), controls.deps);

      expect(response.status).toBe(503);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_KEYLESS;
      else process.env.ALLOW_KEYLESS = previous;
    }
  });

  test("preflight rejects an incorrect credential", async () => {
    const controls = await configuredDeps();

    const response = await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": "wrong-key" },
    }), controls.deps);

    expect(response.status).toBe(401);
  });

  test("preflight reports Events without an enabled experience as unavailable", async () => {
    const missing = controlDeps();
    const zeroFrames = controlDeps();
    await zeroFrames.deps.store.writeConfig("launch", { frames: [] });

    expect((await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
    }), missing.deps)).status).toBe(409);
    expect((await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
    }), zeroFrames.deps)).status).toBe(409);
  });

  test("preflight exposes no private configuration fields", async () => {
    const controls = await configuredDeps();
    const response = await postBoothPreflight(request("/api/booth/preflight?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
    }), controls.deps);
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["experience", "operationalState", "serverTime"]);
    expect(JSON.stringify(body)).not.toContain("boothKeyHash");
    expect(JSON.stringify(body)).not.toContain("currentRevisionId");
  });

  test("heartbeat rejects unknown or unbounded fields before writing", async () => {
    const controls = controlDeps();
    const unknown = await postBoothHeartbeat(request("/api/booths?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
      body: { ...heartbeat, unexpected: true },
    }), controls.deps);
    const unbounded = await postBoothHeartbeat(request("/api/booths?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
      body: { ...heartbeat, buildId: "x".repeat(129) },
    }), controls.deps);

    expect(unknown.status).toBe(400);
    expect(unbounded.status).toBe(400);
    expect((await controls.state.list()).objects).toEqual([]);
  });

  test("a Booth Key cannot write a heartbeat for another Event", async () => {
    const controls = await configuredDeps();
    const response = await postBoothHeartbeat(request("/api/booths?event=other", {
      method: "POST",
      headers: { "x-booth-key": BOOTH_KEY },
      body: heartbeat,
    }), controls.deps);

    expect(response.status).toBe(401);
    expect((await controls.state.list({ prefix: "events/other/" })).objects).toEqual([]);
  });

  test("device listing and pause mutation require the Admin Key", async () => {
    const controls = await configuredDeps();
    await controls.deps.store.writeBoothHeartbeat("launch", heartbeat);

    const list = await getBoothHeartbeats(request("/api/booths?event=launch", {
      headers: { "x-booth-key": BOOTH_KEY },
    }), controls.deps);
    const pause = await putBoothState(request("/api/booth-state?event=launch", {
      method: "PUT",
      headers: { "x-booth-key": BOOTH_KEY },
      body: { paused: true },
    }), controls.deps);

    expect(list.status).toBe(401);
    expect(pause.status).toBe(401);
    expect(await controls.deps.store.readBoothOperationalState("launch")).toEqual({
      version: 1,
      paused: false,
      updatedAt: NOW,
    });
  });

  test("device listing preserves a long opaque store cursor", async () => {
    const opaqueCursor = `opaque.${"x".repeat(2049)}`;
    const store = new OpaqueCursorStore(
      new InMemoryObjectStore(),
      new InMemoryObjectStore(),
      "https://photos.example"
    );
    const response = await getBoothHeartbeats(request(
      `/api/booths?event=launch&cursor=${encodeURIComponent(opaqueCursor)}`,
      { headers: { "x-booth-key": ADMIN_KEY } }
    ), { store, adminKey: ADMIN_KEY });

    expect(response.status).toBe(200);
    expect(store.receivedOptions).toEqual({ cursor: opaqueCursor });
    expect(await response.json()).toEqual({ booths: [], cursor: "store-issued" });
  });

  test("public pause reads are no-store and contain no device or configuration data", async () => {
    const controls = await configuredDeps();
    await controls.deps.store.writeBoothHeartbeat("launch", heartbeat);
    await controls.deps.store.writeBoothOperationalState("launch", {
      paused: true,
      messages: { en: "A brief pause" },
    });

    const response = await getBoothState(request("/api/booth-state?event=launch"), controls.deps);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      version: 1,
      paused: true,
      messages: { en: "A brief pause" },
      updatedAt: NOW,
    });
    expect(JSON.stringify(body)).not.toContain("deviceId");
    expect(JSON.stringify(body)).not.toContain("boothKeyHash");
    expect(JSON.stringify(body)).not.toContain("currentRevisionId");
  });

  test("all Booth control handlers reject canonical Event aliases", async () => {
    const controls = controlDeps();
    const preflight = await postBoothPreflight(request("/api/booth/preflight?event=Launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
    }), controls.deps);
    const heartbeatResponse = await postBoothHeartbeat(request("/api/booths?event=Launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY },
      body: heartbeat,
    }), controls.deps);
    const list = await getBoothHeartbeats(request("/api/booths?event=Launch", {
      headers: { "x-booth-key": ADMIN_KEY },
    }), controls.deps);
    const state = await getBoothState(request("/api/booth-state?event=Launch"), controls.deps);
    const put = await putBoothState(request("/api/booth-state?event=Launch", {
      method: "PUT",
      headers: { "x-booth-key": ADMIN_KEY },
      body: { paused: true },
    }), controls.deps);

    expect([preflight, heartbeatResponse, list, state, put].map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400,
    ]);
  });
});
