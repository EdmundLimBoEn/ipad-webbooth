import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffPanel, isCurrentQrImage } from "./handoff-panel";

const labels = {
  queued: "Safely queued",
  title: "Your exact photo",
  body: "Scan this code",
  viewPhoto: "Open exact photo",
  continue: "Continue",
};

test("waiting handoff announces durable queueing and always offers Continue", () => {
  const html = renderToStaticMarkup(
    <HandoffPanel
      handoff={{ captureId: "current", status: "waiting" }}
      labels={labels}
      onContinue={() => {}}
    />,
  );

  expect(html).toContain('role="status"');
  expect(html).toContain("Safely queued");
  expect(html).toContain("Continue");
  expect(html).not.toContain("<img");
});

test("ready handoff focuses its heading and links visibly to the identical QR target", () => {
  const galleryUrl =
    "https://booth.example/summer-party/gallery?photo=summer-party%2Fcurrent.jpg";
  const html = renderToStaticMarkup(
    <HandoffPanel
      handoff={{
        captureId: "current",
        status: "ready",
        key: "summer-party/current.jpg",
        photoUrl: "https://photos.example/current.jpg",
        galleryUrl,
      }}
      labels={labels}
      onContinue={() => {}}
    />,
  );

  expect(html).toContain('tabindex="-1"');
  expect(html).toContain("Your exact photo");
  expect(html).toContain(`href="${galleryUrl.replaceAll("&", "&amp;")}"`);
  expect(html).toContain("Open exact photo");
  expect(html).toContain("Continue");
});

test("a stale asynchronous QR result cannot match a newer handoff", () => {
  const newer = {
    captureId: "newer",
    status: "ready" as const,
    key: "summer-party/newer.jpg",
    photoUrl: "https://photos.example/newer.jpg",
    galleryUrl:
      "https://booth.example/summer-party/gallery?photo=summer-party%2Fnewer.jpg",
  };

  expect(isCurrentQrImage(newer, {
    captureId: "older",
    galleryUrl:
      "https://booth.example/summer-party/gallery?photo=summer-party%2Folder.jpg",
    dataUrl: "data:image/png;base64,older",
  })).toBe(false);
  expect(isCurrentQrImage(newer, {
    captureId: "newer",
    galleryUrl: newer.galleryUrl,
    dataUrl: "data:image/png;base64,newer",
  })).toBe(true);
});
