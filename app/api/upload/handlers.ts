import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
  InvalidStoredRehearsalError,
  PhotoIndexWriteError,
  RehearsalNotFoundError,
} from "@/app/event-store";
import { InvalidUploadHeadersError, parseUploadHeaders } from "@/app/upload-contract";
import { boothOrAdminOk, isImage, MAX_UPLOAD_BYTES } from "@/app/upload-auth";

export type UploadHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};

const jsonError = (error: string, status: number, headers?: HeadersInit) =>
  NextResponse.json({ error }, { status, headers });

function eventFrom(req: NextRequest): string | NextResponse {
  try {
    return canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return jsonError(error.message, 400);
    throw error;
  }
}

function declaredSizeTooLarge(req: NextRequest): boolean {
  const contentLength = req.headers.get("content-length");
  return contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_UPLOAD_BYTES;
}

/**
 * HTTP-only validation around the Event Store's upload seam. Kept outside the
 * route module because Next.js route modules may only export HTTP methods.
 */
export async function handleUpload(req: NextRequest, deps: UploadHandlerDeps): Promise<NextResponse> {
  const event = eventFrom(req);
  if (event instanceof NextResponse) return event;

  const provided = req.headers.get("x-booth-key") ?? "";
  let auth = await boothOrAdminOk(provided, deps.adminKey);
  if (auth === "disabled") return jsonError("upload disabled: no key configured", 503);

  // Early reject via declared size before buffering the whole body.
  if (declaredSizeTooLarge(req)) return jsonError("too large", 413);

  let intent;
  try {
    // Stable headers are checked before consuming the potentially large body,
    // guaranteeing malformed identities make no public or private writes.
    intent = parseUploadHeaders(req.headers);
  } catch (error) {
    if (error instanceof InvalidUploadHeadersError) return jsonError(error.code, 400);
    throw error;
  }

  // Resolve the private Event-scoped Booth Key only after strict upload-header
  // validation. readConfig() may lazily migrate a legacy public config, so
  // calling it earlier would let an invalid request write to STATE.
  if (auth === "unauthorized") {
    const config = await deps.store.readConfig(event);
    auth = await boothOrAdminOk(provided, deps.adminKey, config?.boothKeyHash);
  }
  if (auth !== "ok") return jsonError("unauthorized", 401);

  if (intent.kind === "stable" && intent.rehearsalId) {
    try {
      await deps.store.readRehearsal(event, intent.rehearsalId);
    } catch (error) {
      if (error instanceof RehearsalNotFoundError) {
        return jsonError("rehearsal unavailable", 409);
      }
      if (error instanceof InvalidStoredRehearsalError) {
        return jsonError("rehearsal evidence unavailable", 503, { "Retry-After": "1" });
      }
      throw error;
    }
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return jsonError("empty body", 400);
  if (body.byteLength > MAX_UPLOAD_BYTES) return jsonError("too large", 413);
  if (!isImage(new Uint8Array(body.slice(0, 12)))) return jsonError("not an image", 415);

  try {
    const photo = await deps.store.putPhoto(event, body, {
      ...(intent.kind === "stable" ? { upload: intent } : {}),
    });
    if (intent.kind === "stable" && intent.rehearsalId) {
      try {
        await deps.store.recordRehearsalUpload(
          event,
          intent.rehearsalId,
          intent,
          photo,
        );
      } catch {
        return NextResponse.json(
          { error: "rehearsal evidence unavailable", retryable: true },
          { status: 503, headers: { "Retry-After": "1" } },
        );
      }
    }
    // `url` remains first-class for older Booth clients; identity fields are
    // additive for stable clients and moderation/retry diagnostics.
    return NextResponse.json({ url: photo.url, key: photo.key, duplicate: photo.duplicate });
  } catch (error) {
    if (error instanceof PhotoIndexWriteError) {
      // An acknowledged stable client can safely retry this exact identity.
      return NextResponse.json(
        { error: "photo index unavailable", retryable: true },
        { status: 503, headers: { "Retry-After": "1" } }
      );
    }
    throw error;
  }
}
