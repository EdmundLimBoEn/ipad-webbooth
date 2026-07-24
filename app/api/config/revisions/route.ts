import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { hashBoothKey } from "@/app/upload-auth";
import { getConfigRevisions } from "../handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  const store = EventStore.fromEnv(env);
  return getConfigRevisions(req, {
    store,
    adminKey: env.BOOTH_UPLOAD_KEY,
    hashBoothKey,
  });
}
