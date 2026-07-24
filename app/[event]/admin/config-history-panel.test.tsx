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
      mutationBusy={false}
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

const revisions = [
  {
    version: 1 as const,
    id: "018f0000-0000-7000-8000-000000000030",
    createdAt: "2026-07-24T00:00:00.000Z",
    parentRevisionId: "018f0000-0000-7000-8000-000000000029",
    reason: "save" as const,
    config: { frames: ["one"] },
  },
  {
    version: 1 as const,
    id: "018f0000-0000-7000-8000-000000000029",
    createdAt: "2026-07-23T23:00:00.000Z",
    parentRevisionId: null,
    reason: "baseline" as const,
    config: { frames: ["two"] },
  },
];

test("the active restore control says exactly Restoring after confirmation closes", () => {
  const html = renderToStaticMarkup(
    <ConfigHistoryPanel
      currentFrames={["one"]}
      currentRevisionId={revisions[0].id}
      revisions={revisions}
      loading={false}
      restoringRevisionId={revisions[1].id}
      mutationBusy
      error=""
      onReload={() => {}}
      onRestore={() => {}}
    />
  );

  const buttonLabels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)]
    .map((match) => match[1]);
  expect(buttonLabels).toContain("Restoring…");
});

test("saving disables every restore control", () => {
  const html = renderToStaticMarkup(
    <ConfigHistoryPanel
      currentFrames={["one"]}
      currentRevisionId={revisions[0].id}
      revisions={revisions}
      loading={false}
      restoringRevisionId={null}
      mutationBusy
      error=""
      onReload={() => {}}
      onRestore={() => {}}
    />
  );

  expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
});
