import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoLightbox, type PhotoLightboxLabels } from "./photo-lightbox";

const photo = {
  key: "events/show/1700000000000-photo.jpg",
  url: "https://photos.example/show/photo.jpg",
  uploadedAt: "2026-07-24T12:00:00.000Z",
};

const labels: PhotoLightboxLabels = {
  title: "Photo viewer",
  photoAlt: "Event photo",
  save: "Save",
  share: "Share",
  close: "Close",
  previous: "Previous",
  next: "Next",
  working: "Working…",
  actionError: "Action failed",
};

test("renders a labelled exact-photo modal with semantic controls and status regions", () => {
  const exactUrl =
    "https://booth.example/show/gallery?photo=events%2Fshow%2F1700000000000-photo.jpg";
  const html = renderToStaticMarkup(
    <PhotoLightbox
      event="show"
      photo={photo}
      origin="https://booth.example"
      labels={labels}
      onClose={() => {}}
    />
  );

  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledBy).toStartWith("photo-lightbox-title-");
  expect(html).toContain(`id="${labelledBy}"`);
  expect(html).toContain(`<img src="${photo.url}" alt="Event photo"`);
  expect(html).toContain(">Save</button>");
  expect(html).toContain(">Share</button>");
  expect(html).toContain('aria-label="Close"');
  expect(html).toContain('role="status"');
  expect(html).toContain('role="alert"');
  expect(html).toContain(`<a href="${exactUrl}"`);
  expect(html).toContain("<bdi>");
});

test("renders optional previous and next actions without owning navigation state", () => {
  const html = renderToStaticMarkup(
    <PhotoLightbox
      event="show"
      photo={photo}
      origin="https://booth.example"
      labels={labels}
      onClose={() => {}}
      onPrevious={() => {}}
      onNext={() => {}}
    />
  );

  expect(html).toContain('aria-label="Previous"');
  expect(html).toContain('aria-label="Next"');
});
