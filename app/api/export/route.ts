import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { TEMPLATES } from "@/app/templates";
import { handleExport } from "./handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  return handleExport(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
    frameLabelFor: (frameKey) => TEMPLATES[frameKey]?.label,
    now: () => new Date(),
  });
}
