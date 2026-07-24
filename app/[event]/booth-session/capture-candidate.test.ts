import { describe, expect, test } from "bun:test";
import { decodePhotoFileToCanvas } from "./capture-candidate";

describe("file-camera review candidate", () => {
  test("decodes into one canvas that can enter the exact review path", async () => {
    let closed = 0;
    const bitmap = {
      width: 640,
      height: 480,
      close: () => {
        closed++;
      },
    } as unknown as ImageBitmap;
    const drawCalls: unknown[][] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]) => drawCalls.push(args),
      }),
    } as unknown as HTMLCanvasElement;

    const decoded = await decodePhotoFileToCanvas(
      new Blob(["camera"]),
      async () => bitmap,
      () => canvas,
    );

    expect(decoded).toBe(canvas);
    expect([canvas.width, canvas.height]).toEqual([640, 480]);
    expect(drawCalls).toEqual([[bitmap, 0, 0]]);
    expect(closed).toBe(1);
  });

  test("rejects undecodable input instead of passing its bytes to a JPEG Outbox row", async () => {
    await expect(decodePhotoFileToCanvas(
      new Blob(["not an image"], { type: "image/heic" }),
      async () => {
        throw new DOMException("decode failed", "InvalidStateError");
      },
      () => ({}) as HTMLCanvasElement,
    )).rejects.toThrow("Could not decode this photo");
  });
});
