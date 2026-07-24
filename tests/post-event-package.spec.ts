import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const EVENT = "post-event-package";
const ADMIN_KEY = "browser-admin-secret";

type ExportFixture = {
  status: number;
  requests: Array<{
    url: string;
    key: string;
  }>;
  delay: boolean;
};

async function installAdminMocks(
  context: BrowserContext,
  fixture: ExportFixture,
) {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = request.headers()["x-booth-key"] ?? "";

    if (url.pathname === "/api/export") {
      fixture.requests.push({ url: url.href, key });
      if (fixture.delay) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (fixture.status !== 200) {
        await route.fulfill({
          status: fixture.status,
          contentType: "application/json",
          body: JSON.stringify({ error: "raw private error must not render" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/zip",
        headers: {
          "content-disposition": url.searchParams.get("format") === "package"
            ? `attachment; filename="${EVENT}-package.zip"`
            : `attachment; filename="${EVENT}-photos.zip"`,
        },
        body: "PK fixture archive",
      });
      return;
    }

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
            locales: ["en"],
            defaultLocale: "en",
            timeZone: "Asia/Singapore",
          },
          currentRevisionId: null,
          revisions: [],
        }),
      });
      return;
    }
    if (url.pathname === "/api/photos") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ photos: [], cursor: null }),
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
    throw new Error(`Unexpected Admin API request: ${request.method()} ${url.pathname}`);
  });
}

async function unlock(page: Page) {
  await page.goto(`/${EVENT}/admin`);
  const input = page.getByLabel("Admin key");
  await input.focus();
  await input.fill(ADMIN_KEY);
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: EVENT })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Post-event package" })).toBeVisible();
}

test("Admin downloads exact package and compatibility archives accessibly", async ({
  context,
  page,
}) => {
  const fixture: ExportFixture = { status: 200, requests: [], delay: true };
  await installAdminMocks(context, fixture);
  await unlock(page);

  const exportPanel = page.getByRole("heading", {
    name: "Post-event package",
  }).locator("..");
  const packageButton = exportPanel.getByRole("button").nth(0);
  const photosButton = exportPanel.getByRole("button").nth(1);
  const packageDownload = page.waitForEvent("download");
  await packageButton.click();
  await expect(packageButton).toBeDisabled();
  await expect(photosButton).toBeDisabled();
  await expect(exportPanel.locator('[aria-live="polite"]')).toHaveText(
    "Downloading event package…",
  );
  expect((await packageDownload).suggestedFilename()).toBe(`${EVENT}-package.zip`);

  fixture.delay = false;
  const photosDownload = page.waitForEvent("download");
  await photosButton.click();
  expect((await photosDownload).suggestedFilename()).toBe(`${EVENT}-photos.zip`);

  expect(fixture.requests).toEqual([
    {
      url: `http://127.0.0.1:3100/api/export?event=${EVENT}&format=package&contactSheet=1`,
      key: ADMIN_KEY,
    },
    {
      url: `http://127.0.0.1:3100/api/export?event=${EVENT}`,
      key: ADMIN_KEY,
    },
  ]);
  for (const request of fixture.requests) {
    expect(request.url).not.toContain(ADMIN_KEY);
  }

  const violations = await page.evaluate(() => {
    const issues: string[] = [];
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    if (new Set(ids).size !== ids.length) issues.push("duplicate ids");
    for (const image of document.querySelectorAll("img")) {
      if (!image.hasAttribute("alt")) issues.push("image without alt");
    }
    for (const button of document.querySelectorAll("button")) {
      if (!(button.textContent ?? "").trim() && !button.getAttribute("aria-label")) {
        issues.push("unnamed button");
      }
    }
    return issues;
  });
  expect(violations).toEqual([]);
});

test("Admin renders bounded export errors and a retry remains available", async ({
  context,
  page,
}) => {
  const fixture: ExportFixture = { status: 413, requests: [], delay: false };
  await installAdminMocks(context, fixture);
  await unlock(page);
  const packageButton = page.getByRole("button", {
    name: "Download event package",
  });

  await packageButton.click();
  await expect(page.getByText(/single-ZIP safety limit/)).toBeVisible();
  await expect(page.getByText("raw private error must not render")).toHaveCount(0);
  await expect(packageButton).toBeEnabled();

  fixture.status = 422;
  await packageButton.click();
  await expect(page.getByText(/metadata needs investigation/)).toBeVisible();

  fixture.status = 503;
  await packageButton.click();
  await expect(page.getByText(/temporarily unavailable/)).toBeVisible();

  fixture.status = 200;
  const retryDownload = page.waitForEvent("download");
  await packageButton.click();
  expect((await retryDownload).suggestedFilename()).toBe(`${EVENT}-package.zip`);

  fixture.status = 401;
  await packageButton.click();
  await expect(page.getByRole("heading", { name: /Operator sign-in/i })).toBeVisible();
});
