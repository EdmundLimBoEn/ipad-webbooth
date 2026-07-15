import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { probes } from "@/app/health";
import { adminOk } from "@/app/upload-auth";

export const dynamic = "force-dynamic";

/** Readiness-only probe. Unlike the cron, this never mutates Statuspage. */
export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  const auth = adminOk(req.headers.get("x-booth-key") ?? "", env.BOOTH_UPLOAD_KEY);
  if (auth === "disabled") {
    return NextResponse.json({ error: "health check disabled: no key configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await probes(env));
}
