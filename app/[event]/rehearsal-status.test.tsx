import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RehearsalStatus } from "./rehearsal-status";

test("renders localized stale, durability, exact ID, queue and leave guidance", () => {
  const html = renderToStaticMarkup(
    <RehearsalStatus
      locale="ar"
      state={{
        rehearsal: {
          version: 1,
          id: "018f0000-0000-4000-8000-000000000501",
          startedAt: "2026-07-24T00:00:00.000Z",
          configRevisionId: null,
          frames: ["square"],
          stale: true,
        },
        pendingEvidence: 3,
        durable: false,
        error: null,
      }}
      currentFrame="square"
      onLeave={() => {}}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("<bdi><code>018f0000");
  expect(html).toContain(">3</dd>");
  expect(html).toContain("مغادرة البروفة");
});
