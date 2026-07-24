import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const EVENT = "rehearsal-browser";
const ADMIN_KEY = "browser-admin-secret";
const REHEARSAL_ID = "018f0000-0000-4000-8000-000000000401";
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

const experience = {
  frames: ["square"],
  locales: ["en"],
  defaultLocale: "en",
  timeZone: "Asia/Singapore",
  capture: {
    reviewEnabled: true,
    autoAcceptSeconds: 5,
    countdownAudioDefault: false,
  },
  gallery: {
    title: "Launch gallery",
    accentColor: "#4f46e5",
  },
};

type RequestRecord = {
  method: string;
  pathname: string;
  search: string;
  key: string;
  body: unknown;
};

type TrackedPhoto = {
  captureId: string;
  photoKey: string;
  disposition: "pending" | "canary-deleted" | "retained" | "deleted";
};

type RehearsalFixture = {
  locale: "en" | "ar";
  requests: RequestRecord[];
  presets: Array<{
    version: 1;
    id: string;
    label: string;
    createdAt: string;
    updatedAt: string;
    config: typeof experience;
  }>;
  view: ReturnType<typeof rehearsalView> | null;
  appliedRevisionId: string | null;
  appliedPresetId: string | null;
};

function rehearsalView(
  status: "active" | "stale" = "active",
  trackedPhotos: TrackedPhoto[] = [],
) {
  const incomplete = () => ({ complete: false, evidenceIds: [] as string[] });
  return {
    session: {
      version: 1 as const,
      id: REHEARSAL_ID,
      startedAt: "2026-07-24T00:00:00.000Z",
      configRevisionId: null,
      frames: ["square"],
    },
    summary: {
      status,
      stale: status === "stale",
      requirements: {
        "booth-ready": incomplete(),
        "frames-covered": incomplete(),
        "two-network-failures": incomplete(),
        "reload-recovered": incomplete(),
        "ordered-drain": incomplete(),
        "public-delivery": incomplete(),
        "canary-deleted": incomplete(),
        "outbox-empty": incomplete(),
      },
      manualChecks: {
        composition: false,
        projector: false,
        power: false,
        charging: false,
        "backup-network": false,
      },
      trackedPhotos,
      remainingExactKeys: trackedPhotos
        .filter(({ disposition }) => disposition === "pending")
        .map(({ photoKey }) => photoKey),
    },
  };
}

function updateDisposition(
  fixture: RehearsalFixture,
  photoKey: string,
  disposition: TrackedPhoto["disposition"],
) {
  if (!fixture.view) return;
  fixture.view = rehearsalView(
    fixture.view.summary.status === "stale" ? "stale" : "active",
    fixture.view.summary.trackedPhotos.map((photo) =>
      photo.photoKey === photoKey ? { ...photo, disposition } : photo
    ),
  );
}

async function installAdminMocks(
  context: BrowserContext,
  fixture: RehearsalFixture,
) {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData()
      ? request.postDataJSON() as unknown
      : null;
    fixture.requests.push({
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      key: request.headers()["x-booth-key"] ?? "",
      body,
    });

    const json = (payload: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });

    if (url.pathname === "/api/health") {
      await json({
        upload: { status: "up", detail: "fixture" },
        live: { status: "up", detail: "fixture" },
      });
      return;
    }
    if (url.pathname === "/api/config/revisions") {
      const preset = fixture.presets.find(({ id }) =>
        id === fixture.appliedPresetId
      );
      const config = preset?.config ?? {
        ...experience,
        locales: [fixture.locale],
        defaultLocale: fixture.locale,
      };
      await json({
        config: { ...config, hasBoothKey: true },
        currentRevisionId: fixture.appliedRevisionId,
        revisions: fixture.appliedRevisionId && fixture.appliedPresetId
          ? [{
              version: 1,
              id: fixture.appliedRevisionId,
              createdAt: "2026-07-24T00:01:00.000Z",
              parentRevisionId: null,
              reason: "preset",
              sourcePresetId: fixture.appliedPresetId,
              config,
            }]
          : [],
      });
      return;
    }
    if (url.pathname === "/api/presets" && request.method() === "GET") {
      await json({ presets: fixture.presets, cursor: null });
      return;
    }
    if (
      url.pathname.startsWith("/api/presets/")
      && url.pathname !== "/api/presets/apply"
      && request.method() === "PUT"
    ) {
      const input = body as { label: string; config: typeof experience };
      const id = decodeURIComponent(url.pathname.slice("/api/presets/".length));
      const saved = {
        version: 1 as const,
        id,
        label: input.label,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        config: input.config,
      };
      fixture.presets = [
        ...fixture.presets.filter((preset) => preset.id !== id),
        saved,
      ];
      await json(saved);
      return;
    }
    if (
      url.pathname === "/api/presets/apply"
      && request.method() === "POST"
    ) {
      const input = body as { presetId: string; mutationId: string };
      const preset = fixture.presets.find(({ id }) => id === input.presetId);
      if (!preset) {
        await json({ error: "missing" }, 404);
        return;
      }
      fixture.appliedRevisionId = input.mutationId;
      fixture.appliedPresetId = input.presetId;
      await json({
        ...preset.config,
        hasBoothKey: true,
        currentRevisionId: input.mutationId,
        sourcePresetId: input.presetId,
        idempotent: false,
      });
      return;
    }
    if (url.pathname === "/api/booth-state") {
      await json({
        version: 1,
        paused: false,
        updatedAt: "2026-07-24T12:00:00.000Z",
      });
      return;
    }
    if (url.pathname === "/api/booths") {
      await json({ booths: [], cursor: null });
      return;
    }
    if (url.pathname === "/api/moderation/photos") {
      await json({ photos: [], nextCursor: null });
      return;
    }
    if (url.pathname === "/api/rehearsals" && request.method() === "GET") {
      if (!fixture.view) {
        await json({ error: "missing" }, 404);
      } else {
        await json({ rehearsal: fixture.view });
      }
      return;
    }
    if (url.pathname === "/api/rehearsals" && request.method() === "POST") {
      fixture.view = rehearsalView("active", [
        {
          captureId: "capture-canary",
          photoKey: `${EVENT}/1753315200003-canary.jpg`,
          disposition: "pending",
        },
        {
          captureId: "capture-retain",
          photoKey: `${EVENT}/1753315200002-retain.jpg`,
          disposition: "pending",
        },
        {
          captureId: "capture-delete",
          photoKey: `${EVENT}/1753315200001-delete.jpg`,
          disposition: "pending",
        },
      ]);
      await json({ rehearsal: fixture.view });
      return;
    }
    if (
      url.pathname === "/api/rehearsals/evidence"
      && request.method() === "POST"
    ) {
      const evidence = body as {
        kind: string;
        photoKey?: string;
      };
      if (evidence.photoKey && evidence.kind === "canary-deleted") {
        updateDisposition(fixture, evidence.photoKey, "canary-deleted");
      }
      if (evidence.photoKey && evidence.kind === "photo-retained") {
        updateDisposition(fixture, evidence.photoKey, "retained");
      }
      if (evidence.photoKey && evidence.kind === "photo-deleted") {
        updateDisposition(fixture, evidence.photoKey, "deleted");
      }
      await json({ accepted: true });
      return;
    }
    if (url.pathname === "/api/photos" && request.method() === "DELETE") {
      await json({
        deleted: true,
        key: url.searchParams.get("key"),
        cleanupPending: false,
      });
      return;
    }
    if (url.pathname === "/api/photos" && request.method() === "GET") {
      await json({
        photos: fixture.view?.summary.trackedPhotos.map(({ photoKey }) => ({
          key: photoKey,
          url: PIXEL,
        })) ?? [],
        cursor: null,
      });
      return;
    }
    throw new Error(
      `Unexpected Admin API request: ${request.method()} ${url.pathname}`,
    );
  });
}

async function unlock(page: Page) {
  await page.goto(`/${EVENT}/admin`);
  const input = page.getByLabel("Admin key");
  await input.fill(ADMIN_KEY);
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: EVENT })).toBeVisible();
}

function createFixture(
  options: { locale?: "en" | "ar"; view?: RehearsalFixture["view"] } = {},
): RehearsalFixture {
  return {
    locale: options.locale ?? "en",
    requests: [],
    presets: [{
      version: 1,
      id: "launch-night",
      label: "Launch Night",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      config: experience,
    }],
    view: options.view ?? null,
    appliedRevisionId: null,
    appliedPresetId: null,
  };
}

test("Admin saves a credential-free preset and confirms its exact application", async ({
  context,
  page,
}) => {
  const fixture = createFixture();
  await installAdminMocks(context, fixture);
  await unlock(page);

  await expect(page.getByText(
    "Booth credentials are never copied into presets.",
  )).toBeVisible();
  await page.getByLabel("Preset ID").fill("after-party");
  await page.getByLabel("Preset label").fill("After Party");
  await page.getByRole("button", { name: "Create preset" }).click();
  await expect(page.getByText("Preset After Party saved.")).toBeVisible();

  const save = fixture.requests.find(({ method, pathname }) =>
    method === "PUT" && pathname === "/api/presets/after-party"
  );
  expect(save?.key).toBe(ADMIN_KEY);
  expect(save?.body).toMatchObject({
    label: "After Party",
    expectedUpdatedAt: null,
  });
  expect(JSON.stringify(save?.body)).not.toMatch(
    /admin|boothKey|credential|secret/i,
  );

  const presetRow = page.getByRole("listitem").filter({
    hasText: "After Party",
  });
  await presetRow.getByRole("button", { name: "Review apply" }).click();
  const confirmation = page.getByRole("group", { name: "Apply preset" });
  await expect(confirmation).toContainText(
    `Apply preset After Party to Event ${EVENT}?`,
  );
  await expect(confirmation.getByText("after-party", { exact: true }))
    .toBeVisible();
  await confirmation.getByRole("button", { name: "Apply preset" }).click();
  await expect(page.getByText("Applied preset After Party.")).toBeVisible();

  const apply = fixture.requests.find(({ method, pathname }) =>
    method === "POST" && pathname === "/api/presets/apply"
  );
  expect(apply?.key).toBe(ADMIN_KEY);
  expect(apply?.search).toBe(`?event=${EVENT}`);
  expect(apply?.body).toMatchObject({
    presetId: "after-party",
    baseRevisionId: null,
  });
  expect(JSON.stringify(apply?.body)).not.toContain(ADMIN_KEY);
});

test("guided rehearsal uses only exact tracked-photo dispositions", async ({
  context,
  page,
}) => {
  const fixture = createFixture();
  await installAdminMocks(context, fixture);
  await unlock(page);

  await expect(page.getByRole("heading", { name: "Real-device rehearsal" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Start rehearsal" }).click();
  await expect(page.getByText(
    "Start an immutable rehearsal from the current configuration?",
  )).toBeVisible();
  await page.getByRole("button", { name: "Confirm start" }).click();
  await expect(page.getByText("Status: active")).toBeVisible();
  await expect(page.getByRole("link", {
    name: `http://127.0.0.1:3100/${EVENT}?rehearsal=${REHEARSAL_ID}`,
  })).toHaveAttribute(
    "href",
    `http://127.0.0.1:3100/${EVENT}?rehearsal=${REHEARSAL_ID}`,
  );

  const canaryKey = `${EVENT}/1753315200003-canary.jpg`;
  const retainKey = `${EVENT}/1753315200002-retain.jpg`;
  const deleteKey = `${EVENT}/1753315200001-delete.jpg`;

  const canaryRow = page.getByRole("listitem").filter({ hasText: canaryKey });
  await canaryRow.getByRole("button", {
    name: "Delete as exact canary",
  }).click();
  await expect(canaryRow.getByText("canary-deleted", { exact: true }))
    .toBeVisible();

  const retainRow = page.getByRole("listitem").filter({ hasText: retainKey });
  await retainRow.getByRole("button", { name: "Retain photo" }).click();
  await expect(retainRow.getByText("retained", { exact: true })).toBeVisible();

  const deleteRow = page.getByRole("listitem").filter({ hasText: deleteKey });
  await deleteRow.getByRole("button", { name: "Delete exact photo" }).click();
  const dialog = deleteRow.getByRole("alertdialog");
  await expect(dialog).toContainText(deleteKey);
  await dialog.getByRole("button", { name: "Confirm exact deletion" }).click();
  await expect(deleteRow.getByText("deleted", { exact: true })).toBeVisible();

  const deletes = fixture.requests.filter(({ method, pathname }) =>
    method === "DELETE" && pathname === "/api/photos"
  );
  expect(deletes.map(({ key, search }) => ({ key, search }))).toEqual([
    {
      key: ADMIN_KEY,
      search: `?event=${EVENT}&key=${encodeURIComponent(canaryKey)}`,
    },
    {
      key: ADMIN_KEY,
      search: `?event=${EVENT}&key=${encodeURIComponent(deleteKey)}`,
    },
  ]);
  expect(deletes.every(({ search }) =>
    new URLSearchParams(search).get("key")?.startsWith(`${EVENT}/`)
  )).toBe(true);

  const evidenceKinds = fixture.requests
    .filter(({ pathname }) => pathname === "/api/rehearsals/evidence")
    .map(({ body }) => (body as { kind: string }).kind);
  expect(evidenceKinds).toEqual([
    "canary-designated",
    "canary-deleted",
    "photo-retained",
    "photo-deleted",
  ]);
});

test("stale Arabic rehearsal remains keyboard-usable at 200% in forced colors", async ({
  context,
  page,
}) => {
  const fixture = createFixture({
    locale: "ar",
    view: rehearsalView("stale"),
  });
  await installAdminMocks(context, fixture);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await unlock(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "بروفة الجهاز الحقيقي" }))
    .toBeVisible();
  await expect(page.getByText("قديمة — ابدأ بروفة جديدة")).toBeVisible();
  await expect(page.getByRole("link", {
    name: `http://127.0.0.1:3100/${EVENT}?rehearsal=${REHEARSAL_ID}`,
  })).toBeVisible();

  const start = page.getByRole("button", { name: "بدء بروفة جديدة" });
  await start.scrollIntoViewIfNeeded();
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("بدء بروفة ثابتة من الإعداد الحالي؟"))
    .toBeVisible();
  const cancel = page.getByRole("button", { name: "إلغاء" }).last();
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("بدء بروفة ثابتة من الإعداد الحالي؟"))
    .toHaveCount(0);
});
