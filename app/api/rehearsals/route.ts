import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { getRehearsal, postRehearsal } from "./handlers";

export const dynamic = "force-dynamic";

function deps() {
  const { env } = getCloudflareContext();
  return {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  };
}

export async function GET(req: NextRequest) {
  return getRehearsal(req, deps());
}

export async function POST(req: NextRequest) {
  return postRehearsal(req, deps());
}
