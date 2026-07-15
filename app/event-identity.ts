/** Browser-safe canonical event identity shared by pages and API boundaries. */
export class InvalidEventSlugError extends Error {
  constructor(readonly raw: string | null) {
    super("event must be a canonical lowercase slug (a-z, 0-9, hyphens)");
  }
}

export function canonicalEvent(raw: string | null): string {
  if (raw === null || raw === "") return "event";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) throw new InvalidEventSlugError(raw);
  return raw;
}

/** Produces a canonical suggestion for form input; APIs must use canonicalEvent(). */
export function slugifyEvent(raw: string | null): string {
  const slug = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug || "event";
}
