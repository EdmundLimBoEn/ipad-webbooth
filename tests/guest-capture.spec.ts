import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

const EVENT = "guest-capture";
const BOOTH_KEY = "guest-key";
const LOCALE_KEY = `boothLocale:${EVENT}`;

type HeldUpload = {
  captureId: string;
  route: Route;
};

type GuestFixture = {
  camera: "ready" | "denied";
  audio: "ready" | "denied";
  online: boolean;
  holdUploads: boolean;
  uploadAttempts: string[];
  heldUploads: HeldUpload[];
  photoKeys: Map<string, string>;
  externalRequests: string[];
  pageErrors: string[];
  experience: {
    frames: string[];
    locales: string[];
    defaultLocale: string;
    capture: {
      reviewEnabled: boolean;
      autoAcceptSeconds: number;
      countdownAudioDefault: boolean;
    };
  };
};

type GuestBrowserState = {
  nextCanvasId: number;
  reviewedCanvasIds: string[];
  encodedCanvasIds: string[];
  failNextEncoding: boolean;
  audioStarts: number;
  bitmapCloses: number;
  online: boolean;
};

function createFixture(
  overrides: Partial<Pick<GuestFixture, "camera" | "audio">> = {},
): GuestFixture {
  return {
    camera: overrides.camera ?? "ready",
    audio: overrides.audio ?? "ready",
    online: true,
    holdUploads: false,
    uploadAttempts: [],
    heldUploads: [],
    photoKeys: new Map(),
    externalRequests: [],
    pageErrors: [],
    experience: {
      frames: ["square", "beacon"],
      locales: ["en", "zh-SG", "ar"],
      defaultLocale: "en",
      capture: {
        reviewEnabled: true,
        autoAcceptSeconds: 2,
        countdownAudioDefault: true,
      },
    },
  };
}

async function installGuestMocks(
  context: BrowserContext,
  fixture: GuestFixture,
) {
  await context.addInitScript(({ camera, audio }) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    let fireAutoAccept = () => {};
    window.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 2_000 && typeof callback === "function") {
        fireAutoAccept = () => callback(...args);
      }
      const accelerated = delay === 1_000
        ? 12
        : delay === 300
          ? 4
          : delay === 400
            ? 5
            : delay === 2_000
              ? 120
              : delay === 5_000
                ? 150
                : delay;
      return nativeSetTimeout(callback, accelerated, ...args);
    }) as typeof window.setTimeout;

    const state: GuestBrowserState = {
      nextCanvasId: 0,
      reviewedCanvasIds: [],
      encodedCanvasIds: [],
      failNextEncoding: false,
      audioStarts: 0,
      bitmapCloses: 0,
      online: true,
    };
    Object.defineProperty(window, "__guestCaptureTest", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(window, "__fireGuestAutoAccept", {
      configurable: true,
      value: () => fireAutoAccept(),
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => state.online,
    });

    const nativeCreateElement = Document.prototype.createElement;
    Object.defineProperty(Document.prototype, "createElement", {
      configurable: true,
      value: function (
        this: Document,
        tagName: string,
        options?: ElementCreationOptions,
      ) {
        const element = nativeCreateElement.call(this, tagName, options);
        if (tagName.toLowerCase() === "canvas") {
          state.nextCanvasId += 1;
          element.setAttribute("data-test-canvas-id", String(state.nextCanvasId));
        }
        return element;
      },
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
        clearRect() {},
        createImageData(width: number, height: number) {
          return {
            data: new Uint8ClampedArray(width * height * 4),
            width,
            height,
          };
        },
        putImageData() {},
        fillStyle: "#000",
      }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: () => "data:image/png;base64,iVBORw0KGgo=",
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: function (this: HTMLCanvasElement, callback: BlobCallback) {
        const canvasId = this.dataset.testCanvasId ?? "missing";
        state.encodedCanvasIds.push(canvasId);
        if (state.failNextEncoding) {
          state.failNextEncoding = false;
          callback(null);
          return;
        }
        // Synthetic Blobs cannot be structured-cloned into WebKit's IDB in
        // headless mode. These JPEG marker bytes exercise the same durable row.
        callback(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) as unknown as Blob);
      },
    });
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: async () => ({
        width: 4032,
        height: 3024,
        close: () => {
          state.bitmapCloses += 1;
        },
      }),
    });

    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (camera === "denied") {
          throw new DOMException("camera denied by browser fixture", "NotAllowedError");
        }
        const stream = new MediaStream();
        const track = { stop() {} };
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
          throw new DOMException("gesture unavailable", "NotAllowedError");
        },
      },
    });

    class BrowserAudioContext {
      state: AudioContextState = audio === "ready" ? "running" : "suspended";
      currentTime = 0;
      destination = {};

      async resume() {
        if (audio === "denied") {
          throw new DOMException("audio denied", "NotAllowedError");
        }
        this.state = "running";
      }

      async close() {
        this.state = "closed";
      }

      createOscillator() {
        return {
          frequency: { setValueAtTime() {} },
          connect() {},
          start() {
            state.audioStarts += 1;
          },
          stop() {},
        };
      }

      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() {},
        };
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: BrowserAudioContext,
    });
  }, { camera: fixture.camera, audio: fixture.audio });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      fixture.externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/mock-photo/")) {
      await route.continue();
      return;
    }

    if (url.pathname === "/api/booth/preflight") {
      if (request.headers()["x-booth-key"] !== BOOTH_KEY) {
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
          experience: fixture.experience,
          operationalState: {
            version: 1,
            paused: false,
            updatedAt: "2026-07-24T12:00:00.000Z",
          },
          serverTime: "2026-07-24T12:00:00.000Z",
        }),
      });
      return;
    }

    if (url.pathname === "/api/booth-state") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          paused: false,
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
      if (fixture.holdUploads || !fixture.online) {
        fixture.heldUploads.push({ captureId, route });
        return;
      }
      const key = `${EVENT}/${captureId}.jpg`;
      fixture.photoKeys.set(captureId, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: `/mock-photo/${captureId}.jpg`,
          key,
          duplicate: false,
        }),
      });
      return;
    }

    if (url.pathname === "/api/photo") {
      const key = url.searchParams.get("key") ?? "";
      const captureId = [...fixture.photoKeys.entries()]
        .find(([, storedKey]) => storedKey === key)?.[0];
      if (!captureId || url.searchParams.get("event") !== EVENT) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not found" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          key,
          url: `/mock-photo/${captureId}.jpg`,
          uploadedAt: "2026-07-24T12:00:00.000Z",
        }),
      });
      return;
    }

    if (url.pathname.startsWith("/mock-photo/")) {
      await route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      });
      return;
    }

    throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
  });
}

async function unlock(page: Page) {
  await page.goto(`/${EVENT}`, { waitUntil: "networkidle" });
  await page.getByLabel("Booth Key").fill(BOOTH_KEY);
  await page.getByRole("button", { name: "Unlock Booth" }).click();
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
}

async function browserState(page: Page): Promise<GuestBrowserState> {
  return page.evaluate(() => ({
    ...(window as typeof window & {
      __guestCaptureTest: GuestBrowserState;
    }).__guestCaptureTest,
  }));
}

async function setBrowserOnline(page: Page, online: boolean) {
  await page.evaluate((nextOnline) => {
    const state = (window as typeof window & {
      __guestCaptureTest: GuestBrowserState;
    }).__guestCaptureTest;
    state.online = nextOnline;
    window.dispatchEvent(new Event(nextOnline ? "online" : "offline"));
  }, online);
}

async function outboxIds(page: Page): Promise<string[]> {
  return page.evaluate(async (event) => {
    const request = indexedDB.open("ipad-webbooth", 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ id: string; event: string }>>(
      (resolve, reject) => {
        const transaction = db.transaction("photo-outbox", "readonly");
        const result = transaction.objectStore("photo-outbox").getAll();
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      },
    );
    db.close();
    return rows
      .filter((row) => row.event === event)
      .map((row) => row.id)
      .sort();
  }, EVENT);
}

async function reviewCanvasId(page: Page): Promise<string> {
  const preview = page.getByRole("img", { name: "Photo preview" });
  await expect(preview).toBeVisible();
  const canvas = preview.locator("canvas");
  await expect(canvas).toHaveCount(1);
  const id = await canvas.getAttribute("data-test-canvas-id");
  expect(id).toBeTruthy();
  await page.evaluate((canvasId) => {
    const state = (window as typeof window & {
      __guestCaptureTest: GuestBrowserState;
    }).__guestCaptureTest;
    state.reviewedCanvasIds.push(canvasId);
  }, id!);
  return id!;
}

async function captureFrame(page: Page, buttonName: RegExp) {
  await page.getByRole("button", { name: buttonName }).click();
  await page.getByRole("button", { name: "Start" }).click();
}

async function acknowledge(
  fixture: GuestFixture,
  expectedCaptureId?: string,
) {
  await expect.poll(() => fixture.heldUploads.length).toBeGreaterThan(0);
  const held = fixture.heldUploads.shift()!;
  if (expectedCaptureId) expect(held.captureId).toBe(expectedCaptureId);
  const key = `${EVENT}/${held.captureId}.jpg`;
  fixture.photoKeys.set(held.captureId, key);
  await held.route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: `/mock-photo/${held.captureId}.jpg`,
      key,
      duplicate: false,
    }),
  });
  return { captureId: held.captureId, key };
}

async function seriousGuestAccessibilityIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const name = (element: Element) =>
      element.getAttribute("aria-label")
      || element.getAttribute("alt")
      || (element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        ? [...element.labels ?? []].map((label) => label.textContent?.trim()).join(" ")
        : "")
      || element.textContent?.trim()
      || "";

    for (const element of document.querySelectorAll("button, a[href], input, select, [role='img']")) {
      if (visible(element) && !name(element)) {
        issues.push(`unnamed ${element.tagName.toLowerCase()}`);
      }
    }
    for (const image of document.querySelectorAll("img")) {
      if (!image.hasAttribute("alt")) issues.push("image missing alt");
    }
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    for (const id of new Set(ids)) {
      if (ids.filter((candidate) => candidate === id).length > 1) {
        issues.push(`duplicate id ${id}`);
      }
    }
    return issues;
  });
}

test("WebKit reviews the exact one-shot and multi-shot canvas before one durable handoff", async ({
  context,
  page,
}) => {
  const fixture = createFixture();
  await installGuestMocks(context, fixture);
  page.on("pageerror", (error) => fixture.pageErrors.push(error.message));
  await unlock(page);

  await captureFrame(page, /Square 1 photo/);
  const firstReviewCanvas = await reviewCanvasId(page);
  expect((await browserState(page)).encodedCanvasIds).toEqual([]);

  await page.getByRole("button", { name: "Retake" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeFocused();
  expect(await outboxIds(page)).toEqual([]);

  await page.getByRole("button", { name: "Start" }).click();
  const acceptedCanvas = await reviewCanvasId(page);
  expect(acceptedCanvas).not.toBe(firstReviewCanvas);
  await page.getByRole("button", { name: "More Time" }).click();
  await page.waitForTimeout(220);
  await expect(page.getByRole("img", { name: "Photo preview" })).toBeVisible();
  expect(await outboxIds(page)).toEqual([]);

  fixture.online = false;
  fixture.holdUploads = true;
  await setBrowserOnline(page, false);
  await page.getByRole("button", { name: "Use Photo" }).click();
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();
  const [firstCaptureId] = await outboxIds(page);
  expect(firstCaptureId).toBeTruthy();
  expect((await browserState(page)).encodedCanvasIds).toEqual([acceptedCanvas]);

  fixture.online = true;
  await setBrowserOnline(page, true);
  const firstAcknowledgement = await acknowledge(fixture, firstCaptureId);
  const link = page.getByRole("link", { name: "View photo" });
  const firstGalleryUrl =
    `http://127.0.0.1:3100/${EVENT}/gallery?photo=${encodeURIComponent(firstAcknowledgement.key)}`;
  await expect(link).toHaveAttribute(
    "href",
    firstGalleryUrl,
  );
  await expect(page.locator("img[data-gallery-url]")).toHaveAttribute(
    "data-gallery-url",
    await link.getAttribute("href") as string,
  );

  const directPagePromise = context.waitForEvent("page");
  await link.click();
  const directPage = await directPagePromise;
  await expect(directPage.getByRole("heading", { name: "Your photo is ready" })).toBeVisible();
  await expect(directPage.getByRole("img", { name: "Photo preview" })).toHaveAttribute(
    "src",
    `/mock-photo/${firstCaptureId}.jpg`,
  );
  expect(directPage.url()).toContain(
    `/${EVENT}/gallery?photo=${encodeURIComponent(firstAcknowledgement.key)}`,
  );
  await directPage.close();

  await page.getByRole("button", { name: "Continue" }).click();
  fixture.holdUploads = true;
  await captureFrame(page, /Beacon 3 photos/);
  const multiReviewCanvas = await reviewCanvasId(page);
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();
  const multiCaptureId = (await outboxIds(page))[0];
  expect(multiCaptureId).toBeTruthy();
  expect((await browserState(page)).encodedCanvasIds).toContain(multiReviewCanvas);
  expect((await browserState(page)).audioStarts).toBeGreaterThanOrEqual(4);

  fixture.holdUploads = false;
  await acknowledge(fixture, multiCaptureId);
  await expect(page.getByRole("heading", { name: "Your photo is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});

test("WebKit fences encode races and keeps the newer handoff during delayed recovery", async ({
  context,
  page,
}) => {
  const fixture = createFixture();
  await installGuestMocks(context, fixture);
  page.on("pageerror", (error) => fixture.pageErrors.push(error.message));
  await unlock(page);

  await captureFrame(page, /Square 1 photo/);
  const failedCanvas = await reviewCanvasId(page);
  await page.getByRole("button", { name: "More Time" }).click();
  await page.evaluate(() => {
    (window as typeof window & {
      __guestCaptureTest: GuestBrowserState;
    }).__guestCaptureTest.failNextEncoding = true;
  });
  await page.getByRole("button", { name: "Use Photo" }).click();
  await expect(page.getByText("We couldn’t safely save this photo.")).toBeVisible();
  expect(await outboxIds(page)).toEqual([]);

  fixture.online = false;
  fixture.holdUploads = true;
  await setBrowserOnline(page, false);
  await page.getByRole("button", { name: "Use Photo" }).click();
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();
  const [olderId] = await outboxIds(page);
  expect((await browserState(page)).encodedCanvasIds)
    .toEqual([failedCanvas, failedCanvas]);

  await page.getByRole("button", { name: "Continue" }).click();
  await captureFrame(page, /Square 1 photo/);
  const newerCanvas = await reviewCanvasId(page);
  await page.evaluate(() => {
    (window as typeof window & {
      __fireGuestAutoAccept(): void;
    }).__fireGuestAutoAccept();
    const buttons = [...document.querySelectorAll("button")];
    const use = buttons.find((button) => button.textContent?.trim() === "Use Photo");
    use?.click();
  });
  await expect.poll(async () => (await outboxIds(page)).length).toBe(2);
  const newerId = (await outboxIds(page)).find((id) => id !== olderId)!;
  expect(newerId).toBeTruthy();
  expect((await browserState(page)).encodedCanvasIds.filter(
    (canvasId) => canvasId === newerCanvas,
  )).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();

  fixture.online = true;
  await setBrowserOnline(page, true);
  const olderAcknowledgement = await acknowledge(fixture, olderId);
  expect(olderAcknowledgement.captureId).toBe(olderId);
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();
  await expect(page.getByRole("link", { name: "View photo" })).toHaveCount(0);

  const newerAcknowledgement = await acknowledge(fixture, newerId);
  const exactLink = page.getByRole("link", { name: "View photo" });
  await expect(exactLink).toHaveAttribute(
    "href",
    `http://127.0.0.1:3100/${EVENT}/gallery?photo=${encodeURIComponent(newerAcknowledgement.key)}`,
  );
  expect(await outboxIds(page)).toEqual([]);
  expect(new Set(fixture.uploadAttempts)).toEqual(new Set([olderId, newerId]));
  expect(fixture.pageErrors).toEqual([]);
});

test("WebKit persists Arabic, falls back to English, and preserves keyboard semantics", async ({
  context,
  page,
}) => {
  const fixture = createFixture();
  await installGuestMocks(context, fixture);
  page.on("pageerror", (error) => fixture.pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await unlock(page);

  await page.getByLabel("Language").selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "اختر إطارًا" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY)).toBe("ar");
  await page.reload();
  await expect(page.getByRole("heading", { name: "اختر إطارًا" })).toBeVisible();

  fixture.experience = {
    ...fixture.experience,
    locales: ["en"],
    defaultLocale: "unsupported",
  };
  await page.evaluate((key) => localStorage.setItem(key, "unsupported"), LOCALE_KEY);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Pick a style" })).toBeVisible();
  // WebKit can report an aborted poll as an access-control page error while a
  // reload replaces the document. Audit the settled English guest surface.
  fixture.pageErrors.length = 0;

  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /Square 1 photo/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Start" })).toBeFocused();
  await page.keyboard.press("Enter");
  await reviewCanvasId(page);
  await expect(page.getByRole("button", { name: "Use Photo" })).toBeFocused();
  expect(await seriousGuestAccessibilityIssues(page)).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});

test("WebKit file-camera fallback reaches review when camera and audio are unavailable", async ({
  context,
  page,
}) => {
  const fixture = createFixture({ camera: "denied", audio: "denied" });
  await installGuestMocks(context, fixture);
  page.on("pageerror", (error) => fixture.pageErrors.push(error.message));
  await page.goto(`/${EVENT}`, { waitUntil: "networkidle" });
  await page.getByLabel("Booth Key").fill(BOOTH_KEY);
  await page.getByRole("button", { name: "Unlock Booth" }).click();
  await expect(page.getByText("Camera unavailable. Use your device camera instead:"))
    .toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "fallback.heic",
    mimeType: "image/heic",
    buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]),
  });
  const fallbackCanvas = await reviewCanvasId(page);
  fixture.holdUploads = true;
  await page.getByRole("button", { name: "Use Photo" }).click();
  await expect(page.getByRole("heading", { name: "Photo safely queued." })).toBeVisible();
  expect((await browserState(page)).encodedCanvasIds).toEqual([fallbackCanvas]);
  expect((await browserState(page)).bitmapCloses).toBe(1);
  expect((await browserState(page)).audioStarts).toBe(0);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});
