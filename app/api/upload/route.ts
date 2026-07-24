import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { handleUpload } from "./handlers";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  return handleUpload(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
