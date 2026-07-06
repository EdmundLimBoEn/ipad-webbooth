import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { adminOk, safeEvent } from "@/app/upload-auth";
import { localPart, centralPart, endPart } from "@/app/zip";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  // Admin key only — a per-event booth key must never bulk-download photos.
  const auth = adminOk(req.headers.get("x-booth-key") ?? "", env.BOOTH_UPLOAD_KEY);
  if (auth === "disabled") {
    return NextResponse.json({ error: "export disabled: no key configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const event = safeEvent(req.nextUrl.searchParams.get("event"));

  const objects: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `${event}/`, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // STORE zip has no ZIP64 — reject past its hard limits instead of silently
  // emitting a corrupt archive.
  const totalBytes = objects.reduce((n, o) => n + o.size, 0);
  if (objects.length > 0xffff || totalBytes > 3.9e9) {
    return NextResponse.json({ error: "event too large for a single zip" }, { status: 413 });
  }

  // Stream the zip: fetch and emit one object per pull, central directory
  // last — memory stays at one photo instead of the whole event (which OOMed
  // the 128 MB Worker isolate when buffered with Promise.all + concat).
  const te = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (i < objects.length) {
        const { key } = objects[i++];
        const obj = await env.PHOTOS.get(key);
        if (!obj) continue; // deleted mid-export; skip it
        const data = new Uint8Array(await obj.arrayBuffer());
        const name = te.encode(key.split("/").pop() ?? key);
        const { bytes, crc } = localPart(name, data);
        central.push(centralPart({ name, crc, size: data.length, offset }));
        offset += bytes.length;
        controller.enqueue(bytes);
        return;
      }
      const centralLen = central.reduce((n, c) => n + c.length, 0);
      for (const c of central) controller.enqueue(c);
      controller.enqueue(endPart(central.length, centralLen, offset));
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${event}-photos.zip"`,
    },
  });
}
