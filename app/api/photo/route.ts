import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { getPublicPhoto } from "./handlers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { env } = getCloudflareContext();
  return getPublicPhoto(request, { store: EventStore.fromEnv(env) });
}
