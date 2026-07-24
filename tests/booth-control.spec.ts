import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const EVENT = "browser-journey";
const STORAGE_KEY = `webbooth:${EVENT}:booth-key`;
const RECOVERED_ID = "10000000-0000-4000-8000-000000000001";
const ACCEPTED_KEYS = new Set(["session-key", "remember-key", "fresh-key"]);

type ApiFixture = {
  paused: boolean;
  uploadMode: "success" | "lost-ack" | "permanent";
  uploadAttempts: string[];
  acknowledgedIds: Set<string>;
  reconnectAcknowledgement: boolean;
  stateRequests: number;
  externalRequests: string[];
  pageErrors: string[];
};

async function installBrowserMocks(context: BrowserContext, fixture: ApiFixture) {
  await context.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      const accelerated = delay === 1_000
        ? 150
        : delay === 300
          ? 45
          : delay === 400
            ? 60
            : delay === 5_000
              ? 120
            : delay;
      return nativeSetTimeout(callback, accelerated, ...args);
    }) as typeof window.setTimeout;

    const state = {
      cameraRequests: Number(sessionStorage.getItem("__booth-camera-requests") ?? 0),
      trackStops: Number(sessionStorage.getItem("__booth-track-stops") ?? 0),
      wakeRequests: Number(sessionStorage.getItem("__booth-wake-requests") ?? 0),
      timeline: [] as string[],
    };
    Object.defineProperty(window, "__boothTest", {
      configurable: true,
      value: state,
    });

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => {},
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({
        translate() {},
        scale() {},
        drawImage() {},
        fillRect() {},
        fillStyle: "#000",
      }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) => {
        // WebKit headless cannot structured-clone a synthetic Blob into
        // IndexedDB. The app only transports these bytes after capture, so a
        // cloneable byte view preserves the durable handoff path under test.
        callback(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) as unknown as Blob);
      },
    });
    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        state.cameraRequests++;
        sessionStorage.setItem("__booth-camera-requests", String(state.cameraRequests));
        const stream = new MediaStream();
        const track = {
          readyState: "live",
          stop() {
            if (this.readyState === "ended") return;
            this.readyState = "ended";
            state.trackStops++;
            state.timeline.push("track-stop");
            sessionStorage.setItem("__booth-track-stops", String(state.trackStops));
          },
        };
        Object.defineProperty(stream, "getTracks", {
          configurable: true,
          value: () => [track],
        });
        return stream;
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          state.wakeRequests++;
          sessionStorage.setItem("__booth-wake-requests", String(state.wakeRequests));
          throw new DOMException("test gesture restriction", "NotAllowedError");
        },
      },
    });

    const pendingOutboxIds = new WeakMap<IDBTransaction, string[]>();
    const nativeTransaction = IDBDatabase.prototype.transaction;
    Object.defineProperty(IDBDatabase.prototype, "transaction", {
      configurable: true,
      value: function (
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
      ) {
        const transaction = nativeTransaction.call(this, storeNames, mode, options);
        const names = typeof storeNames === "string" ? [storeNames] : storeNames;
        if (mode === "readwrite" && names.includes("photo-outbox")) {
          transaction.addEventListener("complete", () => {
            for (const id of pendingOutboxIds.get(transaction) ?? []) {
              state.timeline.push(`outbox-commit:${id}`);
            }
          }, { once: true });
        }
        return transaction;
      },
    });
    const nativePut = IDBObjectStore.prototype.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (
          this.name === "photo-outbox"
          && value
          && typeof value === "object"
          && typeof (value as { id?: unknown }).id === "string"
        ) {
          const ids = pendingOutboxIds.get(this.transaction) ?? [];
          ids.push((value as { id: string }).id);
          pendingOutboxIds.set(this.transaction, ids);
        }
        return key === undefined
          ? nativePut.call(this, value)
          : nativePut.call(this, value, key);
      },
    });
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      fixture.externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (url.pathname === "/api/booth/preflight") {
      const key = request.headers()["x-booth-key"] ?? "";
      if (!ACCEPTED_KEYS.has(key)) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          experience: { frames: ["square", "beacon"] },
          operationalState: {
            version: 1,
            paused: fixture.paused,
            updatedAt: "2026-07-24T12:00:00.000Z",
          },
          serverTime: "2026-07-24T12:00:00.000Z",
        }),
      });
      return;
    }

    if (url.pathname === "/api/booth-state") {
      fixture.stateRequests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          paused: fixture.paused,
          updatedAt: "2026-07-24T12:00:00.000Z",
        }),
      });
      return;
    }

    if (url.pathname === "/api/booths") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }

    if (url.pathname === "/api/upload") {
      const captureId = request.headers()["x-capture-id"] ?? "missing";
      fixture.uploadAttempts.push(captureId);
      if (fixture.uploadMode === "permanent") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "test rejection" }),
        });
        return;
      }
      if (fixture.uploadMode === "lost-ack" && !fixture.reconnectAcknowledgement) {
        fixture.acknowledgedIds.add(captureId);
        await route.abort("connectionfailed");
        return;
      }
      fixture.acknowledgedIds.add(captureId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "data:image/jpeg;base64,/9j/2Q==",
          key: `${EVENT}/mock.jpg`,
          duplicate: fixture.uploadAttempts.filter((id) => id === captureId).length > 1,
        }),
      });
      return;
    }

    throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
  });
}

async function seedRecoveredPhoto(page: Page) {
  await page.evaluate(async ({ event, id }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ipad-webbooth", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("photo-outbox")) {
          request.result.createObjectStore("photo-outbox", { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains("photo-outbox-leases")) {
          request.result.createObjectStore("photo-outbox-leases", { keyPath: "event" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(
        request.error?.message ?? "opening the browser fixture outbox failed"
      ));
      request.onblocked = () => reject(new Error("browser fixture outbox was blocked"));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox", "readwrite");
      transaction.objectStore("photo-outbox").put({
        id,
        event,
        // This recovered fixture never reaches upload; a byte array avoids a
        // WebKit headless Blob-cloning limitation while exercising real IDB.
        blob: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        createdAt: 1,
        attempts: 1,
        lastError: "saved browser fixture",
        failureKind: "permanent",
        errorClass: "payload",
        metadata: {
          capturedAt: 1,
          source: "framed",
          frameKey: "square",
        },
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(
        transaction.error?.message ?? "seeding the browser fixture outbox failed"
      ));
      transaction.onabort = () => reject(new Error(
        transaction.error?.message ?? "seeding the browser fixture outbox aborted"
      ));
    });
    db.close();
  }, { event: EVENT, id: RECOVERED_ID });
}

async function deleteOutboxPhoto(page: Page, id: string) {
  await page.evaluate(async (itemId) => {
    const request = indexedDB.open("ipad-webbooth", 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(
        request.error?.message ?? "opening the browser fixture outbox failed"
      ));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox", "readwrite");
      transaction.objectStore("photo-outbox").delete(itemId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(
        transaction.error?.message ?? "deleting the browser fixture outbox row failed"
      ));
    });
    db.close();
  }, id);
}

async function outboxCount(page: Page) {
  return page.evaluate(async (event) => {
    const request = indexedDB.open("ipad-webbooth", 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(
        request.error?.message ?? "opening the browser fixture outbox failed"
      ));
    });
    const rows = await new Promise<Array<{ event: string }>>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox", "readonly");
      const get = transaction.objectStore("photo-outbox").getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(new Error(
        get.error?.message ?? "reading the browser fixture outbox failed"
      ));
    });
    db.close();
    return rows.filter((row) => row.event === event).length;
  }, EVENT);
}

async function cameraState(page: Page) {
  return page.evaluate(() => {
    const state = (window as typeof window & {
      __boothTest: {
        cameraRequests: number;
        trackStops: number;
        wakeRequests: number;
        timeline: string[];
      };
    }).__boothTest;
    return { ...state, timeline: [...state.timeline] };
  });
}

async function resetTimeline(page: Page) {
  await page.evaluate(() => {
    const state = (window as typeof window & {
      __boothTest: { timeline: string[] };
    }).__boothTest;
    state.timeline.length = 0;
  });
}

async function outboxIds(page: Page) {
  return page.evaluate(async (event) => {
    const request = indexedDB.open("ipad-webbooth", 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(
        request.error?.message ?? "opening the browser fixture outbox failed"
      ));
    });
    const rows = await new Promise<Array<{ id: string; event: string }>>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox", "readonly");
      const get = transaction.objectStore("photo-outbox").getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(new Error(
        get.error?.message ?? "reading the browser fixture outbox failed"
      ));
    });
    db.close();
    return rows
      .filter((row) => row.event === event)
      .map((row) => row.id)
      .sort();
  }, EVENT);
}

test("WebKit keeps Booth control credential-free and Outbox-safe", async ({
  context,
  page,
}) => {
  const fixture: ApiFixture = {
    paused: false,
    uploadMode: "success",
    uploadAttempts: [],
    acknowledgedIds: new Set(),
    reconnectAcknowledgement: false,
    stateRequests: 0,
    externalRequests: [],
    pageErrors: [],
  };
  await installBrowserMocks(context, fixture);
  page.on("dialog", (dialog) => void dialog.accept());
  page.on("pageerror", (error) => fixture.pageErrors.push(error.message));

  await page.goto(`/${EVENT}`, { waitUntil: "networkidle" });
  // Next dev may issue one full refresh after its first compilation. Let that
  // settle before seeding origin-scoped IndexedDB and changing routes.
  await page.waitForTimeout(750);
  await seedRecoveredPhoto(page);
  await page.reload();

  await expect(page.getByLabel("Booth readiness").getByText("1 photo waiting safely"))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Unlock Booth" })).toBeVisible();
  expect((await cameraState(page)).cameraRequests).toBe(0);

  await page.getByLabel("Booth Key").fill("wrong-key");
  await page.getByRole("button", { name: "Unlock Booth" }).click();
  await expect(page.getByText("Booth Key rejected")).toBeVisible();
  await expect(page.getByLabel("Booth readiness").getByText("1 photo waiting safely"))
    .toBeVisible();
  expect(await outboxCount(page)).toBe(1);
  expect((await cameraState(page)).cameraRequests).toBe(0);

  await deleteOutboxPhoto(page, RECOVERED_ID);
  await page.reload();
  await expect(page.getByLabel("Booth readiness").getByText("No photos waiting"))
    .toBeVisible();

  await page.getByLabel("Booth Key").fill("session-key");
  await page.getByRole("button", { name: "Unlock Booth" }).click();
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  expect(await page.evaluate((key) => ({
    session: sessionStorage.getItem(key),
    local: localStorage.getItem(key),
  }), STORAGE_KEY)).toEqual({ session: "session-key", local: null });
  expect((await cameraState(page)).cameraRequests).toBeGreaterThan(0);
  await expect.poll(() => fixture.stateRequests).toBeGreaterThan(0);

  expect(fixture.pageErrors).toEqual([]);

  const pickerCamera = await cameraState(page);
  fixture.paused = true;
  await expect(page.getByRole("heading", { name: "Booth paused" })).toBeVisible();
  await expect.poll(async () => (await cameraState(page)).trackStops)
    .toBeGreaterThan(pickerCamera.trackStops);
  expect((await cameraState(page)).cameraRequests).toBe(pickerCamera.cameraRequests);

  fixture.paused = false;
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  await expect.poll(async () => (await cameraState(page)).cameraRequests)
    .toBeGreaterThan(pickerCamera.cameraRequests);

  fixture.uploadMode = "lost-ack";
  await page.getByRole("button", { name: /Square 1 photo/ }).click();
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page.getByRole("button", { name: /Retry 1 pending/ })).toBeVisible();
  await expect.poll(() => fixture.uploadAttempts.length).toBeGreaterThan(0);

  fixture.reconnectAcknowledgement = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: /Retry 1 pending/ })).toHaveCount(0);
  expect(new Set(fixture.uploadAttempts).size).toBe(1);
  expect(fixture.acknowledgedIds.size).toBe(1);

  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();

  fixture.uploadMode = "permanent";
  await resetTimeline(page);
  const captureCamera = await cameraState(page);
  await page.getByRole("button", { name: /Beacon 3 photos/ }).click();
  await page.getByRole("button", { name: "Start" }).click();
  fixture.paused = true;
  await expect(page.getByRole("heading", { name: "Booth paused" })).toBeVisible();
  expect((await cameraState(page)).trackStops).toBe(captureCamera.trackStops);
  await expect(page.getByRole("button", { name: /Retry 1 pending/ })).toBeVisible();
  const [preExitPendingId] = await outboxIds(page);
  expect(preExitPendingId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  await expect.poll(async () => (await cameraState(page)).trackStops)
    .toBeGreaterThan(captureCamera.trackStops);
  const captureTimeline = (await cameraState(page)).timeline;
  expect(captureTimeline.indexOf(`outbox-commit:${preExitPendingId}`))
    .toBeLessThan(captureTimeline.indexOf("track-stop"));

  const stoppedAfterCapture = await cameraState(page);
  fixture.paused = false;
  await expect.poll(async () => (await cameraState(page)).cameraRequests)
    .toBeGreaterThan(stoppedAfterCapture.cameraRequests);
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();

  const beforeExit = await cameraState(page);
  await page.getByRole("button", { name: "Operator" }).click();
  await page.getByLabel("Booth or Admin Key").fill("fresh-key");
  await page.getByRole("button", { name: "Verify and exit" }).click();
  await expect(page.getByRole("heading", { name: "Booth exited" })).toBeVisible();
  await expect(page.getByText("1 pending photo remain in the Photo Outbox.")).toBeVisible();
  expect((await cameraState(page)).trackStops).toBeGreaterThan(beforeExit.trackStops);
  expect(await page.evaluate((key) => ({
    session: sessionStorage.getItem(key),
    local: localStorage.getItem(key),
  }), STORAGE_KEY)).toEqual({ session: null, local: null });
  expect(await outboxIds(page)).toEqual([preExitPendingId]);

  await page.reload();
  await expect(page.getByLabel("Booth readiness").getByText("1 photo waiting safely"))
    .toBeVisible();
  expect(await outboxIds(page)).toEqual([preExitPendingId]);
  await page.getByLabel("Booth Key").fill("remember-key");
  await page.getByLabel("Remember on this iPad").check();
  await page.getByRole("button", { name: "Unlock Booth" }).click();
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  expect(await page.evaluate((key) => ({
    session: sessionStorage.getItem(key),
    local: localStorage.getItem(key),
  }), STORAGE_KEY)).toEqual({ session: null, local: "remember-key" });

  const wakeBeforeRelaunch = (await cameraState(page)).wakeRequests;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  await expect(page.getByText("Screen Wake Lock is unavailable.")).toBeVisible();
  expect((await cameraState(page)).wakeRequests).toBeGreaterThan(wakeBeforeRelaunch);
  expect(await outboxIds(page)).toEqual([preExitPendingId]);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBe(`/${EVENT}/manifest.webmanifest`);
  const manifest = await page.evaluate(async (href) => {
    const response = await fetch(href!);
    return response.json();
  }, manifestHref);
  expect(manifest).toMatchObject({
    id: `/${EVENT}`,
    start_url: `/${EVENT}`,
    scope: `/${EVENT}`,
  });
  expect(JSON.stringify(manifest)).not.toMatch(/boothKey|credential|hash|\?/i);
  expect(page.url()).toBe(`http://127.0.0.1:3100/${EVENT}`);
  expect(fixture.externalRequests).toEqual([]);
});
