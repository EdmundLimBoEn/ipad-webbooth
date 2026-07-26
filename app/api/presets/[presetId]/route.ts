import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { putPreset } from "../handlers";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ presetId: string }> },
) {
  const { presetId } = await context.params;
  const { env } = getCloudflareContext();
  return putPreset(req, presetId, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
