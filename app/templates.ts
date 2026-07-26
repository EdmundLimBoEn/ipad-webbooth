// Runtime compatibility layer. Authoring data lives beside its artwork in
// public/templates/<pack>/manifest.json and is converted to public asset URLs
// by the frame-pack catalog.
export type { Fit, Slot, Template } from "./frame-packs/types";
export { GROUPS, TEMPLATES } from "./frame-packs/catalog";
import { TEMPLATES } from "./frame-packs/catalog";
import type { Template } from "./frame-packs/types";

// Template keys a booth may offer given an event's enabled-frames allowlist
// (from /api/config). No config saved (null) -> just the ungrouped defaults.
// A saved config is the complete list — defaults are on by default in the
// admin UI but CAN be unticked. Unknown keys are ignored. Pure — unit tested.
export function availableTemplates(enabled: string[] | null): string[] {
  if (enabled === null) return Object.keys(TEMPLATES).filter((k) => !TEMPLATES[k].group);
  const on = new Set(enabled);
  return Object.keys(TEMPLATES).filter((k) => on.has(k));
}

// Source rectangle that fills a dw×dh slot from an iw×ih image without
// distortion (center-crop / object-fit: cover). Pure — unit tested.
export function coverRect(iw: number, ih: number, dw: number, dh: number) {
  const imgRatio = iw / ih;
  const dstRatio = dw / dh;
  if (imgRatio > dstRatio) {
    const sw = ih * dstRatio;
    return { sx: (iw - sw) / 2, sy: 0, sw, sh: ih };
  }
  const sh = iw / dstRatio;
  return { sx: 0, sy: (ih - sh) / 2, sw: iw, sh };
}

// Destination rectangle (offsets within a 0-origin dw×dh box) that shows the
// WHOLE iw×ih image, letterboxed to fit (object-fit: contain). Pure — unit
// tested. Nothing is cropped; the leftover box shows the background behind it.
export function containRect(iw: number, ih: number, dw: number, dh: number) {
  const imgRatio = iw / ih;
  const dstRatio = dw / dh;
  if (imgRatio > dstRatio) {
    const h = dw / imgRatio;
    return { dx: 0, dy: (dh - h) / 2, dw, dh: h };
  }
  const w = dh * imgRatio;
  return { dx: (dw - w) / 2, dy: 0, dw: w, dh };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// Composite captured frames (already mirrored, full-res canvases) into the
// template. Browser-only (uses canvas). The returned canvas is the exact
// review surface and remains unencoded until the guest accepts it.
export async function composeToCanvas(
  frames: CanvasImageSource[],
  frameSizes: { w: number; h: number }[],
  t: Template
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = t.canvas.w;
  canvas.height = t.canvas.h;
  const ctx = canvas.getContext("2d")!;

  if (t.background) {
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (t.bgImage) {
    ctx.drawImage(await loadImage(t.bgImage), 0, 0, canvas.width, canvas.height);
  }

  t.slots.forEach((slot, i) => {
    const f = frames[i];
    if (!f) return;
    const { w: iw, h: ih } = frameSizes[i];
    const fit = slot.fit ?? t.fit ?? "cover";
    if (fit === "contain") {
      const r = containRect(iw, ih, slot.w, slot.h);
      ctx.drawImage(f, slot.x + r.dx, slot.y + r.dy, r.dw, r.dh);
    } else {
      const r = coverRect(iw, ih, slot.w, slot.h);
      ctx.drawImage(f, r.sx, r.sy, r.sw, r.sh, slot.x, slot.y, slot.w, slot.h);
    }
  });

  if (t.overlay) {
    ctx.drawImage(await loadImage(t.overlay), 0, 0, canvas.width, canvas.height);
  }

  return canvas;
}

// Encode only after review acceptance so the preview and queued photo share
// one exact composite.
export function encodeCanvas(
  canvas: HTMLCanvasElement,
  quality = 0.9
): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("could not encode the photo"))),
      "image/jpeg",
      quality
    )
  );
}

// Compatibility wrapper for callers that do not yet present a review step.
export async function composite(
  frames: CanvasImageSource[],
  frameSizes: { w: number; h: number }[],
  t: Template
): Promise<Blob> {
  return encodeCanvas(await composeToCanvas(frames, frameSizes, t));
}
