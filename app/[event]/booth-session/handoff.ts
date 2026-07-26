import type { OutboxItem } from "./outbox";
import type { UploadAcknowledgement } from "./session";

export type CurrentHandoff =
  | { captureId: string; status: "waiting" }
  | {
      captureId: string;
      status: "ready";
      key: string;
      photoUrl: string;
      galleryUrl: string;
    };

export function beginHandoff(item: OutboxItem): CurrentHandoff {
  return { captureId: item.id, status: "waiting" };
}

export function applyAcknowledgement(
  current: CurrentHandoff | null,
  acknowledgement: UploadAcknowledgement,
  origin: string,
): CurrentHandoff | null {
  if (!current || current.captureId !== acknowledgement.item.id) return current;
  const key = acknowledgement.result.key;
  if (!key || !isEventPhotoKey(acknowledgement.item.event, key)) return current;
  return {
    captureId: current.captureId,
    status: "ready",
    key,
    photoUrl: acknowledgement.result.url,
    galleryUrl: buildPhotoHandoffUrl(
      origin,
      acknowledgement.item.event,
      key,
    ),
  };
}

function isEventPhotoKey(event: string, key: string): boolean {
  const prefix = `${event}/`;
  if (!key.startsWith(prefix)) return false;
  const filename = key.slice(prefix.length);
  return /^[^/\\?#]+\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i.test(filename);
}

export function buildPhotoHandoffUrl(
  origin: string,
  event: string,
  completeKey: string,
): string {
  const url = new URL(`/${encodeURIComponent(event)}/gallery`, origin);
  url.searchParams.set("photo", completeKey);
  return url.toString();
}
