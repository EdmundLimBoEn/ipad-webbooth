import { test, expect } from "bun:test";
import {
  coverRect,
  containRect,
  availableTemplates,
  composeToCanvas,
  encodeCanvas,
  composite,
  TEMPLATES,
  GROUPS,
  type Template,
} from "./templates";

test("no config -> only ungrouped default frames", () => {
  expect(availableTemplates(null)).toEqual(["square"]);
});

test("a saved config is the complete list — defaults can be off", () => {
  expect(availableTemplates(["lighthouse", "beacon"])).toEqual(["lighthouse", "beacon"]);
  expect(availableTemplates(["square", "starry"])).toEqual(["square", "starry"]);
  expect(availableTemplates([])).toEqual([]);
});

test("unknown keys are ignored", () => {
  expect(availableTemplates(["nope", "starry"])).toEqual(["starry"]);
});

test("every grouped template's group exists in GROUPS", () => {
  for (const t of Object.values(TEMPLATES)) {
    if (t.group) expect(GROUPS[t.group]).toBeString();
  }
});

test("manifest catalog preserves the public runtime contract", () => {
  expect(Object.keys(TEMPLATES)).toEqual([
    "square",
    "lighthouse",
    "beaconSquare",
    "beacon",
    "birthday",
    "sheep",
    "starry",
  ]);
  expect(TEMPLATES.lighthouse.bgImage).toBe(
    "/templates/talent-beacon-9-anniversary/lighthouse.png",
  );
  expect(TEMPLATES.lighthouse.overlay).toBe(
    "/templates/talent-beacon-9-anniversary/lighthouse-overlay.png",
  );
  expect(TEMPLATES.square.group).toBeUndefined();
});

test("square into square = full image", () => {
  const r = coverRect(1000, 1000, 500, 500);
  expect(r).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 1000 });
});

test("wide image into square slot crops the sides", () => {
  const r = coverRect(1600, 900, 500, 500); // 16:9 into 1:1
  expect(r.sh).toBe(900); // full height kept
  expect(r.sw).toBe(900); // cropped to square
  expect(r.sx).toBe(350); // centered
  expect(r.sy).toBe(0);
});

test("tall image into wide slot crops top/bottom", () => {
  const r = coverRect(900, 1600, 540, 500); // portrait into ~square-ish
  expect(r.sw).toBe(900); // full width kept
  expect(Math.round(r.sh)).toBe(833);
  expect(r.sx).toBe(0);
});

test("contain: 16:9 photo into 16:9 slot fills exactly, no bands", () => {
  const r = containRect(1920, 1080, 640, 360); // both 16:9
  expect(r).toEqual({ dx: 0, dy: 0, dw: 640, dh: 360 });
});

test("contain: 4:3 photo into 16:9 slot shows full photo with side bands", () => {
  const r = containRect(1440, 1080, 640, 360); // 4:3 into 16:9
  expect(r.dh).toBe(360); // full height used
  expect(r.dw).toBe(480); // narrower than slot → pillarboxed
  expect(r.dx).toBe(80); // centered: (640-480)/2
  expect(r.dy).toBe(0);
});

test("contain: never crops — drawn box fits inside the slot", () => {
  const r = containRect(1920, 1080, 640, 640); // 16:9 into square
  expect(r.dw).toBeLessThanOrEqual(640);
  expect(r.dh).toBeLessThanOrEqual(640);
  expect(r.dx).toBe(0);
  expect(Math.round(r.dh)).toBe(360); // letterboxed top/bottom
});

type FakeCanvas = HTMLCanvasElement & {
  encodingCalls: Array<{ type?: string; quality?: number }>;
};

async function withCanvasEnvironment<T>(
  run: (calls: string[], canvases: FakeCanvas[]) => Promise<T>,
): Promise<T> {
  const calls: string[] = [];
  const canvases: FakeCanvas[] = [];
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");

  class FakeImage {
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    private value = "";

    set src(src: string) {
      this.value = src;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this.value;
    }
  }

  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: FakeImage,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag: string) {
        expect(tag).toBe("canvas");
        const context = {
          fillStyle: "",
          fillRect(x: number, y: number, w: number, h: number) {
            calls.push(`background:${this.fillStyle}:${x},${y},${w},${h}`);
          },
          drawImage(source: CanvasImageSource, ...coordinates: number[]) {
            const name =
              source instanceof FakeImage
                ? source.src
                : (source as unknown as { name: string }).name;
            calls.push(`image:${name}:${coordinates.join(",")}`);
          },
        };
        const canvas = {
          width: 0,
          height: 0,
          encodingCalls: [] as Array<{ type?: string; quality?: number }>,
          getContext: () => context,
          toBlob(
            callback: BlobCallback,
            type?: string,
            quality?: number,
          ) {
            canvas.encodingCalls.push({ type, quality });
            callback(new Blob(["jpeg"], { type }));
          },
          toDataURL() {
            canvas.encodingCalls.push({ type: "data-url" });
            return "data:image/jpeg;base64,";
          },
        } as unknown as FakeCanvas;
        canvases.push(canvas);
        return canvas;
      },
    },
  });

  try {
    return await run(calls, canvases);
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
    } else {
      delete (globalThis as { document?: Document }).document;
    }
    if (previousImage) {
      Object.defineProperty(globalThis, "Image", previousImage);
    } else {
      delete (globalThis as { Image?: typeof Image }).Image;
    }
  }
}

const layeredTemplate: Template = {
  label: "Layered",
  shots: 1,
  intervalMs: 0,
  canvas: { w: 600, h: 400 },
  background: "#123456",
  bgImage: "/background.png",
  overlay: "/overlay.png",
  slots: [{ x: 50, y: 25, w: 500, h: 350 }],
};

test("composeToCanvas preserves background, photo, and overlay draw order without encoding", async () => {
  await withCanvasEnvironment(async (calls, canvases) => {
    const canvas = await composeToCanvas(
      [{ name: "photo" } as unknown as CanvasImageSource],
      [{ w: 1000, h: 700 }],
      layeredTemplate,
    );

    expect(canvas).toBe(canvases[0]);
    expect({ width: canvas.width, height: canvas.height }).toEqual({
      width: 600,
      height: 400,
    });
    expect(calls.map((call) => call.split(":")[0] + ":" + call.split(":")[1])).toEqual([
      "background:#123456",
      "image:/background.png",
      "image:photo",
      "image:/overlay.png",
    ]);
    expect(canvases[0].encodingCalls).toEqual([]);
  });
});

test("encodeCanvas is the single JPEG encoding boundary with a configurable quality", async () => {
  await withCanvasEnvironment(async (_calls, canvases) => {
    const canvas = await composeToCanvas([], [], {
      ...layeredTemplate,
      background: undefined,
      bgImage: undefined,
      overlay: undefined,
      slots: [],
    });

    await expect(encodeCanvas(canvas, 0.75)).resolves.toBeInstanceOf(Blob);
    expect(canvases[0].encodingCalls).toEqual([
      { type: "image/jpeg", quality: 0.75 },
    ]);
  });
});

test("composite remains a compose-then-encode compatibility wrapper", async () => {
  await withCanvasEnvironment(async (_calls, canvases) => {
    await expect(composite([], [], {
      ...layeredTemplate,
      background: undefined,
      bgImage: undefined,
      overlay: undefined,
      slots: [],
    })).resolves.toBeInstanceOf(Blob);

    expect(canvases).toHaveLength(1);
    expect(canvases[0].encodingCalls).toEqual([
      { type: "image/jpeg", quality: 0.9 },
    ]);
  });
});
