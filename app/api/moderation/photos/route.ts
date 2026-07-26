import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { getModerationPhotos } from "./handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  return getModerationPhotos(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
