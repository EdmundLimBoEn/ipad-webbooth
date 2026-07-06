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
//
// GROUPING — frames belong to a `group` (one folder per event/design drop under
// /public/templates/<group>/, one label in GROUPS). Ungrouped frames (the pink
// square) are the defaults: on until a config says otherwise, but they can be
// turned off. Grouped frames only show up once enabled per event
// in that event's admin page (/{event}/admin),
// which stores the allowlist at blob `_config/{event}.json`. To add frames:
// make a new folder under /public/templates/, add the group to GROUPS, and tag
// each new TEMPLATES entry with the group id.

export type Fit = "cover" | "contain";

export type Slot = { x: number; y: number; w: number; h: number; fit?: Fit };

export type Template = {
  label: string;
  group?: string; // key of GROUPS; absent = default frame, always available
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

// group id -> display label (admin UI section headers)
export const GROUPS: Record<string, string> = {
  "talent-beacon-9-anniversary": "Talent Beacon 9 Anniversary",
};

const TB9 = "talent-beacon-9-anniversary";

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
    group: TB9,
    shots: 1,
    intervalMs: 3000,
    canvas: { w: 1080, h: 1080 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/lighthouse.png",
    overlay: "/templates/talent-beacon-9-anniversary/lighthouse-overlay.png",
    slots: [{ x: 67, y: 70, w: 946, h: 782 }],
  },
  beaconSquare: {
    label: "Beacon Square",
    group: TB9,
    shots: 1,
    intervalMs: 3000,
    canvas: { w: 1080, h: 1080 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/beacon-square.png",
    slots: [{ x: 67, y: 70, w: 946, h: 782 }],
  },
  beacon: {
    label: "Beacon",
    group: TB9,
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/beacon.png",
    slots: stripSlots([518, 1010, 1503]),
  },
  birthday: {
    label: "Birthday",
    group: TB9,
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/birthday.png",
    slots: stripSlots([213, 758, 1299]),
  },
  sheep: {
    label: "Baaa-thday",
    group: TB9,
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/sheep.png",
    slots: stripSlots([310, 838, 1367]),
  },
  starry: {
    label: "Starry",
    group: TB9,
    shots: 3,
    intervalMs: 3000,
    canvas: { w: 720, h: 2160 },
    fit: "cover",
    bgImage: "/templates/talent-beacon-9-anniversary/starry.png",
    slots: stripSlots([333, 843, 1352]),
  },
};

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

  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("could not encode the photo"))), "image/jpeg", 0.9)
  );
}
