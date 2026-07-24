import { describe, expect, test } from "bun:test";
import {
  adminExportRequest,
  downloadAdminExport,
  ExportDownloadError,
} from "./export-client";

describe("Admin export client", () => {
  test("builds exact package and compatibility requests with the secret only in a header", () => {
    expect(adminExportRequest({
      event: "launch",
      adminKey: "secret",
      mode: "package",
    })).toEqual({
      url: "/api/export?event=launch&format=package&contactSheet=1",
      suggestedName: "launch-package.zip",
      headers: { "x-booth-key": "secret" },
    });
    const photos = adminExportRequest({
      event: "launch",
      adminKey: "secret",
      mode: "photos",
    });
    expect(photos).toEqual({
      url: "/api/export?event=launch",
      suggestedName: "launch-photos.zip",
      headers: { "x-booth-key": "secret" },
    });
    expect(`${photos.url}${photos.suggestedName}`).not.toContain("secret");
  });

  test("asks for a file destination before fetching and pipes the response body", async () => {
    const order: string[] = [];
    const written: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(value) { written.push(value); },
    });
    await downloadAdminExport(
      { event: "launch", adminKey: "secret", mode: "package" },
      {
        pickFile: async (name) => {
          order.push(`pick:${name}`);
          return { createWritable: async () => writable };
        },
        fetch: async (url, init) => {
          order.push(`fetch:${url}:${new Headers(init?.headers).get("x-booth-key")}`);
          return new Response(new Uint8Array([1, 2, 3]));
        },
        fallback: () => { throw new Error("fallback should not run"); },
      },
    );

    expect(order).toEqual([
      "pick:launch-package.zip",
      "fetch:/api/export?event=launch&format=package&contactSheet=1:secret",
    ]);
    expect(written).toEqual([new Uint8Array([1, 2, 3])]);
  });

  test("uses bounded status errors and never returns raw response text", async () => {
    for (const status of [401, 413, 422, 503, 500]) {
      await expect(downloadAdminExport(
        { event: "launch", adminKey: "secret", mode: "photos" },
        {
          fetch: async () => new Response("raw private exception", { status }),
          fallback: () => {},
        },
      )).rejects.toEqual(new ExportDownloadError(status));
    }
  });
});
