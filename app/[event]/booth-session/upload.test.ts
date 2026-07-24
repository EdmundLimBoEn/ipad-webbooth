import { describe, expect, test } from "bun:test";
import { outboxUploadHeaders } from "./upload";

const blob = new Blob(["photo"], { type: "image/jpeg" });

describe("outboxUploadHeaders", () => {
  test("old rows gain stable headers from id and createdAt", () => {
    const item = {
      id: "018f0000-0000-4000-8000-000000000001",
      event: "launch",
      blob,
      createdAt: 1753315200000,
      attempts: 0,
    };
    expect(outboxUploadHeaders(item)).toEqual({
      "x-capture-id": item.id,
      "x-captured-at": "1753315200000",
    });
  });

  test("uses persisted optional metadata when it is valid", () => {
    expect(outboxUploadHeaders({
      id: "018f0000-0000-4000-8000-000000000001",
      event: "launch",
      blob,
      createdAt: 1753315200000,
      attempts: 0,
      metadata: {
        capturedAt: 1753315200999,
        source: "framed",
        frameKey: "square",
        configRevisionId: "release_1",
      },
      rehearsalId: "018f0000-0000-4000-8000-000000000501",
    })).toEqual({
      "x-capture-id": "018f0000-0000-4000-8000-000000000001",
      "x-captured-at": "1753315200999",
      "x-capture-source": "framed",
      "x-frame-key": "square",
      "x-config-revision-id": "release_1",
      "x-rehearsal-id": "018f0000-0000-4000-8000-000000000501",
    });
  });

  test("an invalid historical ID or timestamp falls back to the legacy upload contract", () => {
    expect(outboxUploadHeaders({
      id: "old-non-uuid-id",
      event: "launch",
      blob,
      createdAt: 1753315200000,
      attempts: 0,
    })).toEqual({});
    expect(outboxUploadHeaders({
      id: "018f0000-0000-4000-8000-000000000001",
      event: "launch",
      blob,
      createdAt: 1,
      attempts: 0,
    })).toEqual({});
  });
});
