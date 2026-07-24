import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { InvalidPhotoReceiptError } from "@/app/photo-metadata";
import { ExportTooLargeError } from "@/app/export-stream";
import { handleExport, type ExportHandlerDeps } from "./handlers";

function request(
  query: string,
  key = "admin-secret",
): NextRequest {
  return new NextRequest(`https://booth.example/api/export?${query}`, {
    headers: { "x-booth-key": key },
  });
}

function deps(overrides: Partial<ExportHandlerDeps> = {}) {
  let reads = 0;
  const empty = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const store = {
    async readConfig() { reads++; return { frames: [], timeZone: "Asia/Singapore" }; },
  } as unknown as EventStore;
  return {
    value: {
      store,
      adminKey: "admin-secret",
      frameLabelFor: () => undefined,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      preparePhotoOnly: async () => empty(),
      preparePackage: async () => empty(),
      ...overrides,
    },
    reads: () => reads,
  };
}

describe("export HTTP boundary", () => {
  test("authenticates before validation or storage", async () => {
    const missing = deps({ adminKey: undefined });
    expect((await handleExport(request("event=Launch Event"), missing.value)).status).toBe(503);
    expect(missing.reads()).toBe(0);

    const wrong = deps();
    expect((await handleExport(request("event=launch", "booth-key"), wrong.value)).status).toBe(401);
    expect(wrong.reads()).toBe(0);
  });

  test("accepts only canonical exact query contracts", async () => {
    for (const query of [
      "event=Launch",
      "event=launch&format=package",
      "event=launch&contactSheet=1",
      "event=launch&format=other",
      "event=launch&format=package&contactSheet=0",
      "event=launch&format=package&format=package&contactSheet=1",
      "event=launch&format=package&contactSheet=1&contactSheet=1",
      "event=launch&unknown=1",
    ]) {
      const current = deps();
      expect((await handleExport(request(query), current.value)).status).toBe(400);
      expect(current.reads()).toBe(0);
    }
  });

  test("preserves legacy and enriched response contracts", async () => {
    const legacy = await handleExport(request("event=launch"), deps().value);
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("content-type")).toBe("application/zip");
    expect(legacy.headers.get("content-disposition")).toBe('attachment; filename="launch-photos.zip"');
    expect(legacy.headers.get("cache-control")).toBe("private, no-store");
    expect(legacy.headers.get("x-content-type-options")).toBe("nosniff");

    const enriched = await handleExport(
      request("event=launch&format=package&contactSheet=1"),
      deps().value,
    );
    expect(enriched.status).toBe(200);
    expect(enriched.headers.get("content-disposition")).toBe('attachment; filename="launch-package.zip"');
  });

  test("maps expected failures without exposing private detail", async () => {
    const cases = [
      [new ExportTooLargeError("zip_bytes"), 413],
      [new InvalidPhotoReceiptError("launch/private-secret.jpg", "key_mismatch"), 422],
      [new Error("events/launch/photo-metadata/raw-private.json admin-secret"), 503],
    ] as const;
    for (const [failure, status] of cases) {
      const current = deps({
        preparePackage: async () => { throw failure; },
      });
      const response = await handleExport(
        request("event=launch&format=package&contactSheet=1"),
        current.value,
      );
      const text = await response.text();
      expect(response.status).toBe(status);
      expect(text).not.toContain("raw-private");
      expect(text).not.toContain("admin-secret");
      expect(text).not.toContain("launch/private-secret");
    }
  });
});
