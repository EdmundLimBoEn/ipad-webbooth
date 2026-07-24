import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModerationDialog } from "./moderation-dialog";

const photo = {
  key: "launch/1753315200000-private-looking-name.jpg",
  url: "https://photos.example/photo.jpg",
  uploadedAt: "2026-07-24T00:00:00.000Z",
  capturedAt: 1_753_315_200_000,
};

test("renders a labelled inspection dialog with navigation and exact confirmation", () => {
  const html = renderToStaticMarkup(
    <ModerationDialog
      locale="en"
      photo={photo}
      position={2}
      loadedCount={4}
      hasPrevious
      hasNext
      confirming
      deleting={false}
      cleanupPending={false}
      error=""
      returnFocus={null}
      onPrevious={() => {}}
      onNext={() => {}}
      onClose={() => {}}
      onRequestDelete={() => {}}
      onCancelDelete={() => {}}
      onConfirmDelete={() => {}}
    />
  );

  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('aria-labelledby="moderation-dialog-title"');
  expect(html).toContain("Previous");
  expect(html).toContain("Next");
  expect(html).toContain("Close");
  expect(html).toContain("1753315200000-private-looking-name.jpg");
  expect(html).toContain("<bdi><code>launch/1753315200000-private-looking-name.jpg</code></bdi>");
  expect(html).toContain("Confirm exact deletion");
  expect(html).toContain("Cancel");
  expect(html).not.toMatch(/receipt|revision|device/i);
});

test("cleanup warning says the public photo is gone and offers no retry", () => {
  const html = renderToStaticMarkup(
    <ModerationDialog
      locale="en"
      photo={photo}
      position={1}
      loadedCount={1}
      hasPrevious={false}
      hasNext={false}
      confirming={false}
      deleting={false}
      cleanupPending
      error=""
      returnFocus={null}
      onPrevious={() => {}}
      onNext={() => {}}
      onClose={() => {}}
      onRequestDelete={() => {}}
      onCancelDelete={() => {}}
      onConfirmDelete={() => {}}
    />
  );

  expect(html).toContain("The public photo is already deleted");
  expect(html).not.toContain("Retry delete");
  expect(html).toContain('role="status"');
});
