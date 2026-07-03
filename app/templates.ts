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

// The four strip frames come from FRAMES.pdf, rendered to 720x2160 PNGs in
// /public/templates/. Each is drawn as bgImage (the photos land on top, filling
// its three sky-placeholder holes). All four share the same hole geometry:
// x=72, w=575, h=475 (≈1.21:1), only the y offsets differ. fit:"cover" so the
// photo replaces the placeholder exactly with no letterbox — the camera preview
// crops to the same aspect (see page.tsx). To re-measure holes, see HUMANS.md.
const STRIP_W = 575;
const STRIP_H = 475;
const stripSlots = (ys: number[]): Slot[] =>
  ys.map((y) => ({ x: 72, y, w: STRIP_W, h: STRIP_H }));

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
  // Two square Talent Beacon frames from SQUARE FRAME.pdf, rendered to 1080x1080
  // PNGs. The photo hole is the whole sky+grass landscape placeholder:
  // x=67, y=70, 946x782 (~1.21:1), pixel-measured from the renders. Lighthouse
  // adds an overlay (frame art with the hole punched transparent) so the
  // lighthouse/glow that crosses the hole draws on top of the photo.
  lighthouse: {
    label: "Lighthouse",
    shots: 1,
    intervalMs: 3000,
    canvas: { w: 1080, h: 1080 },
    fit: "cover",
    bgImage: "/templates/lighthouse.png",
    overlay: "/templates/lighthouse-overlay.png",
    slots: [{ x: 67, y: 70, w: 946, h: 782 }],
  },
  beaconSquare: {
    label: "Beacon Square",
    shots: 1,
    intervalMs: 3000,
    canvas: { w: 1080, h: 1080 },
    fit: "cover",
    bgImage: "/templates/beacon-square.png",
    slots: [{ x: 67, y: 70, w: 946, h: 782 }],
  },
  beacon: {
    label: "Beacon",
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/beacon.png",
    slots: stripSlots([518, 1010, 1503]),
  },
  birthday: {
    label: "Birthday",
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/birthday.png",
    slots: stripSlots([213, 758, 1299]),
  },
  sheep: {
    label: "Baaa-thday",
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/sheep.png",
    slots: stripSlots([310, 838, 1367]),
  },
  starry: {
    label: "Starry",
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/starry.png",
    slots: stripSlots([333, 843, 1352]),
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
