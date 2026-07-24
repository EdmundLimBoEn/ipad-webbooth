import type { AdminBoothRecord, BoothOperationalStateInput } from "../../booth-control";

/**
 * Reconcile overlapping opaque pages without ever treating a shortened device
 * identifier as an identity. A refreshed record wins only when it is newer.
 */
export function mergeBoothPages(
  ...pages: ReadonlyArray<readonly AdminBoothRecord[]>
): AdminBoothRecord[] {
  const byDeviceId = new Map<string, AdminBoothRecord>();

  for (const page of pages) {
    for (const record of page) {
      const current = byDeviceId.get(record.deviceId);
      if (!current || Date.parse(record.lastSeenAt) > Date.parse(current.lastSeenAt)) {
        byDeviceId.set(record.deviceId, record);
      }
    }
  }

  return [...byDeviceId.values()].sort(
    (left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
  );
}

/** Keep translated operator messages intact while the Admin only edits English. */
export function boothOperationalStateInput(
  currentMessages: Record<string, string> | undefined,
  englishMessage: string,
  paused: boolean
): BoothOperationalStateInput {
  const messages = { ...currentMessages };
  if (englishMessage) messages.en = englishMessage;
  else delete messages.en;

  return {
    paused,
    ...(Object.keys(messages).length > 0 ? { messages } : {}),
  };
}
