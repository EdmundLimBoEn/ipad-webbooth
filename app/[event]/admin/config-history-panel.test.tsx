import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigHistoryPanel, diffFrameKeys } from "./config-history-panel";

test("diffFrameKeys reports additions and removals", () => {
  expect(diffFrameKeys(["one", "three"], ["one", "two"])).toEqual({
    added: ["two"],
    removed: ["three"],
  });
});

test("history renders reasons and disables restoring the current revision", () => {
  const html = renderToStaticMarkup(
    <ConfigHistoryPanel
      currentFrames={["one"]}
      currentRevisionId="018f0000-0000-7000-8000-000000000030"
      revisions={[{
        version: 1,
        id: "018f0000-0000-7000-8000-000000000030",
        createdAt: "2026-07-24T00:00:00.000Z",
        parentRevisionId: null,
        reason: "save",
        config: { frames: ["one"] },
      }]}
      loading={false}
      restoringRevisionId={null}
      error=""
      onReload={() => {}}
      onRestore={() => {}}
    />
  );

  expect(html).toContain("Configuration history");
  expect(html).toContain("R01");
  expect(html).toContain("Current");
  expect(html).toContain("disabled");
  expect(html).not.toContain("boothKey");
});
