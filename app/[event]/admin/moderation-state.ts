import type { ModerationPhoto } from "../../moderation";

export type ModerationFilters = {
  from: string;
  to: string;
};

export type ModerationPageTicket = {
  id: number;
  event: string;
  auth: string;
  filters: ModerationFilters;
};

export type ModerationPageResponse = {
  photos: ModerationPhoto[];
  nextCursor: string | null;
};

export function mergeModerationPage(
  current: readonly ModerationPhoto[],
  incoming: readonly ModerationPhoto[]
): ModerationPhoto[] {
  const exact = new Map<string, ModerationPhoto>();
  for (const photo of current) exact.set(photo.key, photo);
  for (const photo of incoming) exact.set(photo.key, photo);
  return [...exact.values()].sort((left, right) =>
    right.capturedAt - left.capturedAt
    || right.uploadedAt.localeCompare(left.uploadedAt)
    || left.key.localeCompare(right.key)
  );
}

export function removeModeratedPhoto(
  photos: readonly ModerationPhoto[],
  exactKey: string
): {
  photos: ModerationPhoto[];
  nextFocusKey: string | null;
} {
  const index = photos.findIndex((photo) => photo.key === exactKey);
  if (index < 0) return { photos: [...photos], nextFocusKey: null };
  const remaining = photos.filter((photo) => photo.key !== exactKey);
  return {
    photos: remaining,
    nextFocusKey: remaining[index]?.key ?? remaining[index - 1]?.key ?? null,
  };
}

export function filtersChanged(
  current: ModerationFilters,
  next: ModerationFilters
): boolean {
  return current.from !== next.from || current.to !== next.to;
}

export function moderationFilterInstant(value: string): string | null | undefined {
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseModerationPageResponse(value: unknown): ModerationPageResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ["photos", "nextCursor"])) return null;
  if (
    !Array.isArray(value.photos)
    || (value.nextCursor !== null && typeof value.nextCursor !== "string")
    || (typeof value.nextCursor === "string" && value.nextCursor.length === 0)
  ) {
    return null;
  }
  const photos: ModerationPhoto[] = [];
  for (const candidate of value.photos) {
    if (!isRecord(candidate)) return null;
    const allowed = [
      "key",
      "url",
      "uploadedAt",
      "capturedAt",
      "source",
      "frameKey",
    ];
    if (
      Object.keys(candidate).some((key) => !allowed.includes(key))
      || typeof candidate.key !== "string"
      || typeof candidate.url !== "string"
      || typeof candidate.uploadedAt !== "string"
      || Number.isNaN(Date.parse(candidate.uploadedAt))
      || typeof candidate.capturedAt !== "number"
      || !Number.isSafeInteger(candidate.capturedAt)
      || candidate.capturedAt < 0
      || (
        candidate.source !== undefined
        && candidate.source !== "framed"
        && candidate.source !== "camera-fallback"
      )
      || (
        candidate.frameKey !== undefined
        && typeof candidate.frameKey !== "string"
      )
    ) {
      return null;
    }
    photos.push({
      key: candidate.key,
      url: candidate.url,
      uploadedAt: candidate.uploadedAt,
      capturedAt: candidate.capturedAt,
      ...(candidate.source ? { source: candidate.source } : {}),
      ...(candidate.frameKey ? { frameKey: candidate.frameKey } : {}),
    });
  }
  return { photos, nextCursor: value.nextCursor };
}

export class ModerationPageCoordinator {
  private sequence = 0;
  private active = 0;

  begin(
    event: string,
    auth: string,
    filters: ModerationFilters
  ): ModerationPageTicket {
    const ticket = {
      id: ++this.sequence,
      event,
      auth,
      filters: { ...filters },
    };
    this.active = ticket.id;
    return ticket;
  }

  accepts(ticket: ModerationPageTicket): boolean {
    return ticket.id === this.active;
  }

  reset(): void {
    this.active = 0;
  }

  merge(
    ticket: ModerationPageTicket,
    current: readonly ModerationPhoto[],
    currentCursor: string | null,
    incoming: readonly ModerationPhoto[],
    nextCursor: string | null
  ): { photos: ModerationPhoto[]; nextCursor: string | null } | null {
    void currentCursor;
    if (!this.accepts(ticket)) return null;
    return {
      photos: mergeModerationPage(current, incoming),
      nextCursor,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
