import { describe, expect, test } from "bun:test";
import type { OutboxItem } from "./outbox";
import type { UploadAcknowledgement } from "./session";
import {
  applyAcknowledgement,
  beginHandoff,
  buildPhotoHandoffUrl,
} from "./handoff";

function item(id: string): OutboxItem {
  return {
    id,
    event: "summer-party",
    blob: new Blob(["photo"], { type: "image/jpeg" }),
    createdAt: 1,
    attempts: 0,
  };
}

function acknowledgement(
  id: string,
  key: string | undefined = `summer-party/${id}.jpg`,
): UploadAcknowledgement {
  return {
    item: item(id),
    result: {
      url: `https://photos.example/${id}.jpg`,
      ...(key === undefined ? {} : { key }),
    },
  };
}

describe("current photo handoff", () => {
  test("begins waiting for the exact durable Outbox identity", () => {
    expect(beginHandoff(item("current"))).toEqual({
      captureId: "current",
      status: "waiting",
    });
  });

  test("only the exact current identity can become ready", () => {
    const waiting = beginHandoff(item("current"));

    expect(applyAcknowledgement(
      waiting,
      acknowledgement("older"),
      "https://booth.example",
    )).toBe(waiting);
    expect(applyAcknowledgement(
      waiting,
      acknowledgement("current"),
      "https://booth.example",
    )).toEqual({
      captureId: "current",
      status: "ready",
      key: "summer-party/current.jpg",
      photoUrl: "https://photos.example/current.jpg",
      galleryUrl:
        "https://booth.example/summer-party/gallery?photo=summer-party%2Fcurrent.jpg",
    });
  });

  test("duplicate acknowledgement succeeds but a missing legacy key cannot make an exact QR", () => {
    const waiting = beginHandoff(item("current"));
    const duplicate = acknowledgement("current");
    duplicate.result.duplicate = true;

    expect(applyAcknowledgement(waiting, duplicate, "https://booth.example")?.status).toBe("ready");
    const legacy = acknowledgement("current");
    delete legacy.result.key;
    expect(applyAcknowledgement(
      waiting,
      legacy,
      "https://booth.example",
    )).toBe(waiting);
  });

  test("a replacement or dismissed handoff cannot be reopened by a late acknowledgement", () => {
    const newer = beginHandoff(item("newer"));

    expect(applyAcknowledgement(
      newer,
      acknowledgement("older"),
      "https://booth.example",
    )).toBe(newer);
    expect(applyAcknowledgement(
      null,
      acknowledgement("newer"),
      "https://booth.example",
    )).toBeNull();
  });

  test("a cross-Event or non-photo acknowledgement cannot create a handoff", () => {
    const waiting = beginHandoff(item("current"));

    expect(applyAcknowledgement(
      waiting,
      acknowledgement("current", "other-event/current.jpg"),
      "https://booth.example",
    )).toBe(waiting);
    expect(applyAcknowledgement(
      waiting,
      acknowledgement("current", "summer-party/folder/current.jpg"),
      "https://booth.example",
    )).toBe(waiting);
  });

  test("encodes the complete key as one photo query value", () => {
    const url = buildPhotoHandoffUrl(
      "https://booth.example/base",
      "summer-party",
      "summer-party/folder/photo #1.jpg",
    );

    expect(url).toBe(
      "https://booth.example/summer-party/gallery?photo=summer-party%2Ffolder%2Fphoto+%231.jpg",
    );
    expect(new URL(url).searchParams.getAll("photo")).toEqual([
      "summer-party/folder/photo #1.jpg",
    ]);
  });
});
