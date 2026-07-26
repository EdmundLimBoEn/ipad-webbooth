import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminBoothRecord, BoothOperationalState } from "../../booth-control";
import { BoothOperationsPanel } from "./booth-operations-panel";

const record: AdminBoothRecord = {
  version: 1,
  deviceId: "50d5cf8a-9aa3-4e55-a60f-b3a58d3cc7d5",
  lastSeenAt: "2026-07-24T00:01:00.000Z",
  sessionStartedAt: 1_753_408_000_000,
  pendingCount: 3,
  durableStorage: false,
  online: false,
  installed: true,
  camera: "denied",
  upload: "retry-wait",
  lastSuccessfulUploadAt: 1_753_407_940_000,
  errorClass: "network",
  buildId: "release-1",
  stale: true,
};

const operationalState: BoothOperationalState = {
  version: 1,
  paused: true,
  messages: { en: "Hold for lighting", ar: "انتظر الإضاءة" },
  updatedAt: "2026-07-24T00:01:00.000Z",
};

const liveRecord: AdminBoothRecord = {
  ...record,
  deviceId: "30b0c3cf-b0f5-4ce0-8e2a-5460d0e6658f",
  pendingCount: 0,
  durableStorage: true,
  online: true,
  installed: false,
  camera: "ready",
  upload: "idle",
  stale: false,
};

test("renders scannable safe booth state and no credentials or raw errors", () => {
  const html = renderToStaticMarkup(
    <BoothOperationsPanel
      records={[record, liveRecord]}
      cursor="next-page"
      operationalState={operationalState}
      loading={false}
      loadingMore={false}
      mutationBusy={false}
      hasError={false}
      englishMessageDraft="Hold for lighting"
      onEnglishMessageChange={() => {}}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onPause={() => {}}
      onResume={() => {}}
    />
  );

  expect(html).toContain("Stale");
  expect(html).toContain("Live");
  expect(html).toContain("Pending 3");
  expect(html).toContain("Storage durable");
  expect(html).toContain("Storage degraded");
  expect(html).toContain("Installed");
  expect(html).toContain("Camera denied");
  expect(html).toContain("Upload retry-wait");
  expect(html).toContain("Build release-1");
  expect(html).toContain("Resume capture");
  expect(html).toContain('maxLength="280"');
  expect(html).not.toContain("boothKey");
  expect(html).not.toContain("hash");
  expect(html).not.toContain("upstream secret failure");
});

test("makes pause and resume unavailable during a mutation", () => {
  const html = renderToStaticMarkup(
    <BoothOperationsPanel
      records={[]}
      cursor={null}
      operationalState={{ ...operationalState, paused: false }}
      loading={false}
      loadingMore={false}
      mutationBusy
      hasError
      englishMessageDraft=""
      onEnglishMessageChange={() => {}}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onPause={() => {}}
      onResume={() => {}}
    />
  );

  expect(html).toContain("Pausing capture…");
  expect(html).toContain("disabled");
  expect(html).toContain("Booth status needs a refresh.");

  const resumeHtml = renderToStaticMarkup(
    <BoothOperationsPanel
      records={[]}
      cursor={null}
      operationalState={operationalState}
      loading={false}
      loadingMore={false}
      mutationBusy
      hasError={false}
      englishMessageDraft=""
      onEnglishMessageChange={() => {}}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onPause={() => {}}
      onResume={() => {}}
    />
  );

  expect(resumeHtml).toContain("Resuming capture…");
});

test("keeps opaque pagination unavailable while the first page is refreshing", () => {
  const html = renderToStaticMarkup(
    <BoothOperationsPanel
      records={[]}
      cursor={" \t\n "}
      operationalState={operationalState}
      loading
      loadingMore={false}
      mutationBusy={false}
      hasError={false}
      englishMessageDraft=""
      onEnglishMessageChange={() => {}}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onPause={() => {}}
      onResume={() => {}}
    />
  );

  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Load more stations<\/button>/);
});

test("keeps a malformed timestamp from breaking the operator roster", () => {
  const html = renderToStaticMarkup(
    <BoothOperationsPanel
      records={[{ ...record, sessionStartedAt: Number.MAX_SAFE_INTEGER }]}
      cursor={null}
      operationalState={operationalState}
      loading={false}
      loadingMore={false}
      mutationBusy={false}
      hasError={false}
      englishMessageDraft=""
      onEnglishMessageChange={() => {}}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onPause={() => {}}
      onResume={() => {}}
    />
  );

  expect(html).toContain("Unavailable");
});
