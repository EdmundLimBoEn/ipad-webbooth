import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest } from "next/server";
import { EventStore } from "@/app/event-store";
import { deletePhoto, getPhotos } from "./handlers";

// no caching by Next — the gallery polls this for fresh photos
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  return getPhotos(req, { store: EventStore.fromEnv(env) });
}

export async function DELETE(req: NextRequest) {
  const { env } = getCloudflareContext();
  return deletePhoto(req, {
    store: EventStore.fromEnv(env),
    adminKey: env.BOOTH_UPLOAD_KEY,
  });
}
