import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { getPresets } from "./handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  return getPresets(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
