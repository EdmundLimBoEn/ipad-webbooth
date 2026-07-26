import { describe, expect, test } from "bun:test";
import manifest from "./manifest";
import { GET } from "./manifest.webmanifest/route";

describe("per-Event Booth manifest", () => {
  test("uses the canonical Event path as its installed identity and scope", async () => {
    const value = await manifest({
      params: Promise.resolve({ event: "launch-night" }),
    });

    expect(value).toMatchObject({
      id: "/launch-night",
      start_url: "/launch-night",
      scope: "/launch-night",
      display: "standalone",
      orientation: "landscape",
      background_color: "#000000",
      theme_color: "#000000",
    });
    expect(JSON.parse(JSON.stringify(value.icons))).toEqual([
      {
        src: "/booth-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ]);
  });

  test("never serializes a query string or credential-shaped data", async () => {
    const serialized = JSON.stringify(await manifest({
      params: Promise.resolve({ event: "launch-night" }),
    }));

    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("boothKey");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("hash");
  });

  test("rejects a non-canonical Event instead of silently slugging it", async () => {
    await expect(manifest({
      params: Promise.resolve({ event: "Launch Night" }),
    })).rejects.toThrow("canonical lowercase slug");
  });

  test("serves the Event manifest without caching credential-bearing state", async () => {
    const response = await GET(new Request(
      "https://booth.invalid/launch-night/manifest.webmanifest"
    ), {
      params: Promise.resolve({ event: "launch-night" }),
    });
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(JSON.parse(body).start_url).toBe("/launch-night");
    expect(body).not.toContain("boothKey");
    expect(body).not.toContain("credential");
  });

  test("the Booth document links only its canonical Event manifest", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();

    expect(source).toContain('rel="manifest"');
    expect(source).toContain('href={`/${event}/manifest.webmanifest`}');
  });
});
