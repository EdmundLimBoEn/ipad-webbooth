// Photo-booth templates. Each template composites N captured frames onto a
// fixed-size canvas: a background (color OR image) is drawn first, the photos
// are drawn into `slots`, then an optional overlay image is drawn on top.
//
// FLEXIBILITY — everything about the artwork is data here, so when the real
// design arrives you never touch the compositing code, only this config:
//   1. Set `canvas` to the artwork's exact pixel size.
//   2. Set `overlay: "/templates/<file>.png"` (frame art with holes, drawn on
//      top of the photos) or `bgImage` (art behind the photos). Drop the file
//      in /public/templates/.
//   3. Set one `slot` per photo hole, in the artwork's pixel coordinates.
//   4. Set `fit` per template (or per slot) to "contain" (show the whole photo,
//      letterboxed — nothing cropped) or "cover" (fill the hole, cropping
//      overflow). Unknown photo/hole aspect ratios are fine either way.

export type Fit = "cover" | "contain";

export type Slot = { x: number; y: number; w: number; h: number; fit?: Fit };

export type Template = {
  label: string;
  shots: number; // how many photos to take
  intervalMs: number; // countdown seconds*1000 before each shot
  canvas: { w: number; h: number };
  fit?: Fit; // default photo fit for all slots (default "cover")
  background?: string; // solid color, drawn first
  bgImage?: string; // image URL drawn first (overrides feel of background)
  overlay?: string; // image URL drawn last, on top of photos (frame art)
  slots: Slot[];
};

// ponytail: demo art is solid pink. Swap background->bgImage/overlay when the
// real files arrive; slots + fit already define where and how photos land.
//
// The strip slots are 16:9 with fit:"contain" so the FULL photo shows (no crop)
// with pink letterbox bands, and the pink rectangle is sized to hold three of
// them plus a bottom band for a logo/caption.
export const TEMPLATES: Record<string, Template> = {
  square: {
    label: "Square",
    shots: 1,
    intervalMs: 3000,
    canvas: { w: 1080, h: 1080 },
    fit: "cover", // single photo looks best filling the square
    background: "#ffd9e8", // soft pink border
    slots: [{ x: 70, y: 70, w: 940, h: 940 }],
  },
  strip: {
    label: "Photo Strip",
    shots: 3,
    intervalMs: 10000,
    canvas: { w: 700, h: 1360 },
    fit: "contain", // show the whole 16:9 photo, letterboxed in pink
    background: "#ff2d8b", // Barbie pink
    slots: [
      { x: 30, y: 30, w: 640, h: 360 }, // 640x360 = 16:9
      { x: 30, y: 420, w: 640, h: 360 },
      { x: 30, y: 810, w: 640, h: 360 },
    ], // 190px bottom band (1170–1360) left for a logo/caption
  },
};

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
// template. Browser-only (uses canvas). Returns a JPEG blob.
export async function composite(
  frames: CanvasImageSource[],
  frameSizes: { w: number; h: number }[],
  t: Template
): Promise<Blob> {
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

  return new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.9));
}
