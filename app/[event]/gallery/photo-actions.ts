import type { FeedPhoto } from "@/app/photo-feed/types";

export type PrefetchedPhoto = {
  key: string;
  url: string;
  blob: Blob;
};

export type PhotoActionResult =
  | { kind: "shared" }
  | { kind: "downloaded" }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

export type PhotoActionDeps = {
  fetchBlob(url: string): Promise<Blob>;
  canShare(data: ShareData): boolean;
  share(data: ShareData): Promise<void>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  download(objectUrl: string, filename: string): void;
};

export type PhotoActionInput = {
  photo: FeedPhoto;
  prefetched: PrefetchedPhoto | null;
  exactUrl: string;
  deps: PhotoActionDeps;
};

export function exactGalleryUrl(
  origin: string,
  event: string,
  completeKey: string,
): string {
  const url = new URL(`/${encodeURIComponent(event)}/gallery`, origin);
  url.searchParams.set("photo", completeKey);
  return url.toString();
}

export function isCurrentPhotoAction(
  actionGeneration: number,
  currentGeneration: number,
): boolean {
  return actionGeneration === currentGeneration;
}

export function browserPhotoActionDeps(): PhotoActionDeps {
  return {
    async fetchBlob(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Photo returned ${response.status}`);
      return response.blob();
    },
    canShare: (data) =>
      typeof navigator.share === "function"
      && typeof navigator.canShare === "function"
      && navigator.canShare(data),
    share: (data) => navigator.share(data),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    download(objectUrl, filename) {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    },
  };
}

function photoFilename(photo: FeedPhoto): string {
  const name = photo.key.slice(photo.key.lastIndexOf("/") + 1).trim();
  return name || "event-photo.jpg";
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === "AbortError" || error.name === "NotAllowedError");
}

function exactPrefetch(input: PhotoActionInput): Blob | null {
  return input.prefetched?.key === input.photo.key
    && input.prefetched.url === input.photo.url
    ? input.prefetched.blob
    : null;
}

async function blobFor(input: PhotoActionInput): Promise<Blob> {
  return exactPrefetch(input) ?? input.deps.fetchBlob(input.photo.url);
}

async function downloadBlob(input: PhotoActionInput, blob: Blob): Promise<PhotoActionResult> {
  let objectUrl: string | null = null;
  try {
    objectUrl = input.deps.createObjectURL(blob);
    input.deps.download(objectUrl, photoFilename(input.photo));
    return { kind: "downloaded" };
  } catch (error) {
    return {
      kind: "error",
      error: error instanceof Error ? error.message : "Photo action failed",
    };
  } finally {
    if (objectUrl !== null) input.deps.revokeObjectURL(objectUrl);
  }
}

async function tryFileShare(
  input: PhotoActionInput,
  blob: Blob,
): Promise<PhotoActionResult | null> {
  try {
    const file = new File([blob], photoFilename(input.photo), {
      type: blob.type || "image/jpeg",
    });
    const data: ShareData = { files: [file], title: "Event photo", url: input.exactUrl };
    if (!input.deps.canShare(data)) return null;
    await input.deps.share(data);
    return { kind: "shared" };
  } catch (error) {
    if (isCancellation(error)) return { kind: "cancelled" };
    return null;
  }
}

export async function savePhoto(input: PhotoActionInput): Promise<PhotoActionResult> {
  try {
    const blob = await blobFor(input);
    const shared = await tryFileShare(input, blob);
    return shared ?? downloadBlob(input, blob);
  } catch (error) {
    if (isCancellation(error)) return { kind: "cancelled" };
    return {
      kind: "error",
      error: error instanceof Error ? error.message : "Photo action failed",
    };
  }
}

export async function sharePhoto(input: PhotoActionInput): Promise<PhotoActionResult> {
  const prefetched = exactPrefetch(input);
  if (prefetched) {
    const shared = await tryFileShare(input, prefetched);
    if (shared) return shared;
  }

  try {
    await input.deps.share({
      title: "Event photo",
      text: "Event photo",
      url: input.exactUrl,
    });
    return { kind: "shared" };
  } catch (error) {
    if (isCancellation(error)) return { kind: "cancelled" };
  }

  try {
    return downloadBlob(input, await blobFor(input));
  } catch (error) {
    return {
      kind: "error",
      error: error instanceof Error ? error.message : "Photo action failed",
    };
  }
}
