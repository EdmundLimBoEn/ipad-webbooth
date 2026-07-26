import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { hashBoothKey } from "@/app/upload-auth";
import { postConfigRestore } from "../../handlers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  const store = EventStore.fromEnv(env);
  return postConfigRestore(req, {
    store,
    adminKey: env.BOOTH_UPLOAD_KEY,
    hashBoothKey,
  });
}
