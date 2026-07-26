import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { hashBoothKey } from "@/app/upload-auth";
import { getPublicConfig, putConfig } from "./handlers";

// no caching by Next — the booth reads this on every load and admin edits must show up.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  const store = EventStore.fromEnv(env);
  return getPublicConfig(req, {
    store,
    adminKey: env.BOOTH_UPLOAD_KEY,
    hashBoothKey,
  });
}

export async function PUT(req: NextRequest) {
  const { env } = getCloudflareContext();
  const store = EventStore.fromEnv(env);
  return putConfig(req, {
    store,
    adminKey: env.BOOTH_UPLOAD_KEY,
    hashBoothKey,
  });
}
