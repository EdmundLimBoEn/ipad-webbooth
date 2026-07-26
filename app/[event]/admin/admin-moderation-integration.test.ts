import { expect, test } from "bun:test";

test("Admin replaces the public polling contact sheet with authenticated moderation paging", async () => {
  const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();

  expect(source).toContain("/api/moderation/photos?");
  expect(source).toContain('"x-booth-key": adminKey');
  expect(source).toContain("<ModerationPanel");
  expect(source).toContain("<ModerationDialog");
  expect(source).not.toContain("Recent contact sheet");
  expect(source).not.toContain("setInterval(() => void loadPhotos()");
  expect(source).not.toContain("fetch(`/api/photos?${query}`, { cache: \"no-store\" })");
});
