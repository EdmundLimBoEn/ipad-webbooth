import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const EVENT = "gallery-browser";
const ADMIN_EVENT = "moderation-browser";
const ADMIN_KEY = "browser-admin-secret";
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const first = {
  key: `${EVENT}/1753315200002-first.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:02.000Z",
};
const second = {
  key: `${EVENT}/1753315200001-second.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:01.000Z",
};
const third = {
  key: `${EVENT}/1753315200003-third.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:03.000Z",
};
const moderationFirst = {
  key: `${ADMIN_EVENT}/1753315200004-first.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:04.000Z",
  capturedAt: 1753315200004,
  source: "framed",
  frameKey: "square",
};
const moderationSecond = {
  key: `${ADMIN_EVENT}/1753315200003-second.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:03.000Z",
  capturedAt: 1753315200003,
  source: "camera-fallback",
};
const moderationThird = {
  key: `${ADMIN_EVENT}/1753315200002-third.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:02.000Z",
  capturedAt: 1753315200002,
};
const moderationFiltered = {
  key: `${ADMIN_EVENT}/1753315200005-filtered.jpg`,
  url: PIXEL,
  uploadedAt: "2026-07-24T00:00:05.000Z",
  capturedAt: 1753315200005,
};

type ModerationApiRequest = {
  method: string;
  pathname: string;
  key: string;
  search: string;
};

type ModerationFixture = {
  requests: ModerationApiRequest[];
  deletedKeys: Set<string>;
  cleanupPending: boolean;
  delayedCursor: boolean;
  rebuildCalls: number;
  locale: "en" | "ar";
};

async function seriousA11yViolations(page: Page) {
  return (await new AxeBuilder({ page }).analyze()).violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical",
  );
}

async function seriousStructuralA11yViolations(page: Page) {
  return (await new AxeBuilder({ page }).analyze()).violations.filter(
    ({ id, impact }) =>
      id !== "color-contrast"
      && (impact === "serious" || impact === "critical"),
  );
}

async function installGalleryRoutes(
  context: BrowserContext,
  options: { delayedFeed?: boolean } = {},
) {
  let active = 0;
  let maximumActive = 0;
  let feedRequests = 0;
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/photo") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...first,
          key: url.searchParams.get("key"),
        }),
      });
      return;
    }
    if (url.pathname !== "/api/photos") {
      throw new Error(`Unexpected Gallery API request: ${url.pathname}`);
    }
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    feedRequests += 1;
    if (options.delayedFeed) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        photos: feedRequests === 1 ? [first, second] : [],
        cursor: `cursor-${feedRequests}`,
      }),
    });
    active -= 1;
  });
  return {
    stats: () => ({ active, maximumActive, feedRequests }),
  };
}

async function installModerationRoutes(
  context: BrowserContext,
  fixture: ModerationFixture,
) {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = request.headers()["x-booth-key"] ?? "";
    fixture.requests.push({
      method: request.method(),
      pathname: url.pathname,
      key,
      search: url.search,
    });

    if (url.pathname === "/api/health") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          upload: { status: "up", detail: "fixture" },
          live: { status: "up", detail: "fixture" },
        }),
      });
      return;
    }
    if (url.pathname === "/api/config/revisions") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: {
            frames: ["square"],
            hasBoothKey: true,
            locales: ["en", "zh-SG", "ar"],
            defaultLocale: fixture.locale,
            timeZone: "Asia/Singapore",
          },
          currentRevisionId: null,
          revisions: [],
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
        body: JSON.stringify({ booths: [], cursor: null }),
      });
      return;
    }
    if (url.pathname === "/api/moderation/photos/rebuild") {
      fixture.rebuildCalls += 1;
      const complete = fixture.rebuildCalls >= 2;
      await route.fulfill({
        status: complete ? 200 : 202,
        contentType: "application/json",
        body: JSON.stringify({
          complete,
          scanned: complete ? 500 : 250,
          indexed: complete ? 498 : 249,
        }),
      });
      return;
    }
    if (url.pathname === "/api/moderation/photos") {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "page-2" && fixture.delayedCursor) {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      const candidates = url.searchParams.has("from")
        ? [moderationFiltered]
        : cursor === "page-2"
          ? [moderationThird]
          : [moderationFirst, moderationSecond];
      const photos = candidates.filter(
        (photo) => !fixture.deletedKeys.has(photo.key),
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          photos,
          nextCursor: cursor || url.searchParams.has("from") ? null : "page-2",
        }),
      });
      return;
    }
    if (url.pathname === "/api/photos" && request.method() === "DELETE") {
      const exactKey = url.searchParams.get("key") ?? "";
      fixture.deletedKeys.add(exactKey);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          deleted: true,
          key: exactKey,
          cleanupPending: fixture.cleanupPending,
        }),
      });
      return;
    }
    throw new Error(
      `Unexpected Admin API request: ${request.method()} ${url.pathname}`,
    );
  });
}

async function unlockModeration(page: Page, heading = "Event moderation") {
  await page.goto(`/${ADMIN_EVENT}/admin`);
  const input = page.getByLabel("Admin key");
  await input.fill(ADMIN_KEY);
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: ADMIN_EVENT })).toBeVisible();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

test("phone browse opens an exact deep link before its slow feed and restores URL/focus", async ({
  context,
  page,
}) => {
  const routes = await installGalleryRoutes(context, { delayedFeed: true });
  const deepLink = `/${EVENT}/gallery?photo=${encodeURIComponent(first.key)}`;
  await page.goto(deepLink);

  const dialog = page.getByRole("dialog", { name: "Event photo" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(dialog.getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`photo=${encodeURIComponent(first.key)}`),
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(`/${EVENT}/gallery`);

  await expect(page.getByRole("button", { name: "Open event photo" })).toHaveCount(2);
  const secondTile = page.getByRole("button", { name: "Open event photo" }).nth(1);
  await secondTile.focus();
  await secondTile.click();
  await expect(page).toHaveURL(new RegExp(`photo=${encodeURIComponent(second.key)}`));
  await page.getByRole("button", { name: "Close" }).click();
  await expect(secondTile).toBeFocused();
  expect(routes.stats().maximumActive).toBe(1);
  expect(await seriousA11yViolations(page)).toEqual([]);
});

test("projector retains photos across feed errors, retries, and exposes the browse QR", async ({
  context,
  page,
}) => {
  let active = 0;
  let maximumActive = 0;
  let requestCount = 0;
  await context.route("**/api/photos**", async (route) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (requestCount === 2) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary fixture failure" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          photos: requestCount === 1 ? [first, second] : [third],
          cursor: `cursor-${requestCount}`,
        }),
      });
    }
    active -= 1;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${EVENT}/live`);

  await expect(page.getByRole("button", { name: "Open event photo" })).toHaveCount(2);
  await expect(page.getByAltText("Scan to browse event photos on your phone")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Gallery connection lost" }))
    .toContainText("Gallery connection lost", {
    timeout: 7_000,
  });
  await expect(page.getByRole("button", { name: "Open event photo" })).toHaveCount(2);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Open event photo" })).toHaveCount(3);
  expect(maximumActive).toBe(1);
  expect(await seriousA11yViolations(page)).toEqual([]);
});

test("Admin moderation rejects a stale page after filtering and restores dialog focus", async ({
  context,
  page,
}) => {
  const fixture: ModerationFixture = {
    requests: [],
    deletedKeys: new Set(),
    cleanupPending: false,
    delayedCursor: true,
    rebuildCalls: 0,
    locale: "en",
  };
  await installModerationRoutes(context, fixture);
  await unlockModeration(page);

  await expect(page.getByText("2 photos loaded")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect.poll(() =>
    fixture.requests.some(({ pathname, search }) =>
      pathname === "/api/moderation/photos" && search.includes("cursor=page-2")
    )
  ).toBe(true);

  await page.getByLabel("From").fill("2026-07-24T00:00");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("button", { name: "Open photo 1753315200005-filtered.jpg" }),
  ).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText("1 photos loaded")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open photo 1753315200002-third.jpg" }),
  ).toHaveCount(0);

  const filteredRequest = fixture.requests.find(
    ({ pathname, search }) =>
      pathname === "/api/moderation/photos" && search.includes("from="),
  );
  expect(filteredRequest?.key).toBe(ADMIN_KEY);
  expect(filteredRequest?.search).toContain(`event=${ADMIN_EVENT}`);
  expect(filteredRequest?.search).not.toContain(ADMIN_KEY);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("2 photos loaded")).toBeVisible();
  const firstTile = page.getByRole("button", {
    name: "Open photo 1753315200004-first.jpg",
  });
  await firstTile.focus();
  await firstTile.click();
  const dialog = page.getByRole("dialog", { name: "Inspect photo" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByText("Photo 2 of 2 loaded")).toBeVisible();
  await expect(dialog.getByText("1753315200003-second.jpg")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByText("Photo 1 of 2 loaded")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(firstTile).toBeFocused();
  expect(await seriousStructuralA11yViolations(page)).toEqual([]);
});

test("Admin exact deletion does not repeat public removal and rebuild advances one batch per click", async ({
  context,
  page,
}) => {
  const fixture: ModerationFixture = {
    requests: [],
    deletedKeys: new Set(),
    cleanupPending: true,
    delayedCursor: false,
    rebuildCalls: 0,
    locale: "en",
  };
  await installModerationRoutes(context, fixture);
  await unlockModeration(page);
  await expect(page.getByText("2 photos loaded")).toBeVisible();

  await page.getByRole("button", {
    name: "Open photo 1753315200004-first.jpg",
  }).click();
  const dialog = page.getByRole("dialog", { name: "Inspect photo" });
  await dialog.getByRole("button", { name: "Remove photo" }).click();
  await expect(dialog.getByText(moderationFirst.key, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm exact deletion" }).click();
  await expect(dialog.getByText(/public photo is already deleted/i)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove photo" })).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: "Open photo 1753315200004-first.jpg",
  })).toHaveCount(0);
  await page.waitForTimeout(100);

  const deletionRequests = () => fixture.requests.filter(
    ({ method, pathname }) => method === "DELETE" && pathname === "/api/photos",
  );
  expect(deletionRequests()).toEqual([{
    method: "DELETE",
    pathname: "/api/photos",
    key: ADMIN_KEY,
    search:
      `?event=${ADMIN_EVENT}&key=${encodeURIComponent(moderationFirst.key)}`,
  }]);
  await dialog.getByRole("button", { name: "Close" }).click();
  expect(deletionRequests()).toHaveLength(1);

  await page.getByRole("button", { name: "Start rebuild" }).click();
  await expect(page.getByText("Scanned 250; indexed 249.")).toBeVisible();
  await page.waitForTimeout(100);
  expect(fixture.rebuildCalls).toBe(1);
  await page.getByRole("button", { name: "Continue rebuild" }).click();
  await expect(page.getByText("Index rebuild complete.")).toBeVisible();
  expect(fixture.rebuildCalls).toBe(2);
  const rebuildRequests = fixture.requests.filter(
    ({ method, pathname }) =>
      method === "POST" && pathname === "/api/moderation/photos/rebuild",
  );
  expect(rebuildRequests).toHaveLength(2);
  expect(rebuildRequests.every(({ key, search }) =>
    key === ADMIN_KEY && search === `?event=${ADMIN_EVENT}`
  )).toBe(true);
});

test("Arabic moderation remains keyboard-usable at 200% in forced colors", async ({
  context,
  page,
}) => {
  const fixture: ModerationFixture = {
    requests: [],
    deletedKeys: new Set(),
    cleanupPending: false,
    delayedCursor: false,
    rebuildCalls: 0,
    locale: "ar",
  };
  await installModerationRoutes(context, fixture);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await unlockModeration(page, "إشراف صور الفعالية");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const tile = page.getByRole("button", {
    name: "افتح الصورة 1753315200004-first.jpg",
  });
  await tile.scrollIntoViewIfNeeded();
  await tile.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "افحص الصورة" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "إغلاق" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(tile).toBeFocused();
  await expect(page.getByRole("button", { name: "ابدأ إعادة البناء" })).toBeVisible();
  expect(await seriousStructuralA11yViolations(page)).toEqual([]);
});
