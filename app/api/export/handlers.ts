import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  InvalidEventSlugError,
} from "@/app/event-store";
import {
  ExportTooLargeError,
  preparePackageExport,
  preparePhotoOnlyExport,
  type ExportStreamDeps,
} from "@/app/export-stream";
import { InvalidPhotoReceiptError } from "@/app/photo-metadata";
import { adminOk } from "@/app/upload-auth";

type PreparePhotoOnly = typeof preparePhotoOnlyExport;
type PreparePackage = typeof preparePackageExport;

export type ExportHandlerDeps = ExportStreamDeps & {
  adminKey?: string;
  preparePhotoOnly?: PreparePhotoOnly;
  preparePackage?: PreparePackage;
};

const errorResponse = (error: string, status: number) =>
  NextResponse.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );

function queryMode(
  req: NextRequest,
): { event: string; mode: "photos" | "package" } | NextResponse {
  const params = req.nextUrl.searchParams;
  const allowed = new Set(["event", "format", "contactSheet"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      return errorResponse("invalid export request", 400);
    }
  }
  if (params.getAll("event").length !== 1) {
    return errorResponse("invalid export request", 400);
  }
  let event: string;
  try {
    event = canonicalEvent(params.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) {
      return errorResponse("invalid event", 400);
    }
    throw error;
  }

  const format = params.get("format");
  const contactSheet = params.get("contactSheet");
  if (format === null && contactSheet === null) {
    return { event, mode: "photos" };
  }
  if (format === "package" && contactSheet === "1") {
    return { event, mode: "package" };
  }
  return errorResponse("invalid export request", 400);
}

export async function handleExport(
  req: NextRequest,
  deps: ExportHandlerDeps,
): Promise<NextResponse> {
  if (!deps.adminKey) {
    return errorResponse("export unavailable", 503);
  }
  if (adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) !== "ok") {
    return errorResponse("unauthorized", 401);
  }
  const query = queryMode(req);
  if (query instanceof NextResponse) return query;

  try {
    const stream = query.mode === "photos"
      ? await (deps.preparePhotoOnly ?? preparePhotoOnlyExport)(query.event, deps)
      : await (deps.preparePackage ?? preparePackageExport)(
        query.event,
        (await deps.store.readConfig(query.event))?.timeZone,
        deps,
      );
    const suffix = query.mode === "photos" ? "photos" : "package";
    return new NextResponse(stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${query.event}-${suffix}.zip"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      return errorResponse("event is too large for one archive", 413);
    }
    if (error instanceof InvalidPhotoReceiptError) {
      return errorResponse("stored photo metadata is invalid", 422);
    }
    return errorResponse("export temporarily unavailable", 503);
  }
}
