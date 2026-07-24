import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const EVENT = "gallery-browser";
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

async function seriousA11yViolations(page: Page) {
  return (await new AxeBuilder({ page }).analyze()).violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical",
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
