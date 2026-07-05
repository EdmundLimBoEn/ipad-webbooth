import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { keyOk } from "@/app/upload-auth";
import { crc32 } from "@/app/crc32";

function safeEvent(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "event";
}

// Minimal ZIP writer, STORE (no compression) since JPEGs are already
// compressed — deflating them again would just burn CPU for no size win.
// No archiver dependency: crc32 (app/crc32.ts) is the only primitive needed.
function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const le16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  const le32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const localHeader = concat(
      le32(0x04034b50),
      le16(20), // version needed
      le16(0), // flags
      le16(0), // method: store
      le16(0), // mod time
      le16(0), // mod date
      le32(crc),
      le32(data.length), // compressed size
      le32(data.length), // uncompressed size
      le16(nameBytes.length),
      le16(0) // extra field length
    );
    const local = concat(localHeader, nameBytes, data);
    chunks.push(local);

    const centralHeader = concat(
      le32(0x02014b50),
      le16(20), // version made by
      le16(20), // version needed
      le16(0), // flags
      le16(0), // method
      le16(0), // mod time
      le16(0), // mod date
      le32(crc),
      le32(data.length),
      le32(data.length),
      le16(nameBytes.length),
      le16(0), // extra length
      le16(0), // comment length
      le16(0), // disk number
      le16(0), // internal attrs
      le32(0), // external attrs
      le32(offset)
    );
    central.push(concat(centralHeader, nameBytes));
    offset += local.length;
  }

  const centralBlock = concat(...central);
  const end = concat(
    le32(0x06054b50),
    le16(0), // disk number
    le16(0), // disk with central dir
    le16(files.length),
    le16(files.length),
    le32(centralBlock.length),
    le32(offset),
    le16(0) // comment length
  );

  return concat(...chunks, centralBlock, end);
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  const expected = env.BOOTH_UPLOAD_KEY;
  if (!expected) {
    // Fail closed in production, same as the upload/config routes: an unset
    // key must not mean "anyone can bulk-download every event's photos".
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "export disabled: no key configured" }, { status: 503 });
    }
  } else if (!keyOk(req.headers.get("x-booth-key") ?? "", expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const event = safeEvent(req.nextUrl.searchParams.get("event"));

  const objects: { key: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `${event}/`, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const files = await Promise.all(
    objects.map(async ({ key }) => {
      const obj = await env.PHOTOS.get(key);
      const data = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array(0);
      const name = key.split("/").pop() ?? key;
      return { name, data };
    })
  );

  const zip = buildZip(files);
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${event}-photos.zip"`,
    },
  });
}
