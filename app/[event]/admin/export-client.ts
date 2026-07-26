export type AdminExportMode = "package" | "photos";

export type AdminExportRequest = {
  url: string;
  suggestedName: string;
  headers: { "x-booth-key": string };
};

export type SaveFileHandle = {
  createWritable(): Promise<WritableStream<Uint8Array>>;
};

export type ExportDownloadDeps = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  pickFile?: (suggestedName: string) => Promise<SaveFileHandle>;
  fallback: (blob: Blob, suggestedName: string) => void;
};

export class ExportDownloadError extends Error {
  constructor(readonly status: number) {
    super(`export request failed with status ${status}`);
  }
}

export function adminExportRequest(input: {
  event: string;
  adminKey: string;
  mode: AdminExportMode;
}): AdminExportRequest {
  return input.mode === "package"
    ? {
      url: `/api/export?event=${encodeURIComponent(input.event)}&format=package&contactSheet=1`,
      suggestedName: `${input.event}-package.zip`,
      headers: { "x-booth-key": input.adminKey },
    }
    : {
      url: `/api/export?event=${encodeURIComponent(input.event)}`,
      suggestedName: `${input.event}-photos.zip`,
      headers: { "x-booth-key": input.adminKey },
    };
}

export async function downloadAdminExport(
  input: {
    event: string;
    adminKey: string;
    mode: AdminExportMode;
  },
  deps: ExportDownloadDeps,
): Promise<void> {
  const request = adminExportRequest(input);
  // This deliberately happens before the first network await so the native
  // picker retains the click's user activation.
  const handle = deps.pickFile
    ? await deps.pickFile(request.suggestedName)
    : null;
  const response = await deps.fetch(request.url, {
    cache: "no-store",
    headers: request.headers,
  });
  if (!response.ok) throw new ExportDownloadError(response.status);
  if (handle && response.body) {
    await response.body.pipeTo(await handle.createWritable());
    return;
  }
  deps.fallback(await response.blob(), request.suggestedName);
}
