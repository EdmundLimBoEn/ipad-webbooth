import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { postBoothPreflight } from "../handlers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  return postBoothPreflight(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
