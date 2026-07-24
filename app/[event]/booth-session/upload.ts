import {
  InvalidUploadHeadersError,
  parseUploadHeaders,
  stableUploadHeaders,
} from "../../upload-contract";
import type { OutboxItem } from "./outbox";

/**
 * Adapts a durable row into the additive stable-upload protocol. Historical
 * queue rows can predate stable identity, so malformed legacy data must still
 * use the random-key upload path instead of wedging the ordered outbox.
 */
export function outboxUploadHeaders(item: OutboxItem): Record<string, string> {
  const headers = stableUploadHeaders({
    captureId: item.id,
    capturedAt: item.metadata?.capturedAt ?? item.createdAt,
    source: item.metadata?.source,
    frameKey: item.metadata?.frameKey,
    configRevisionId: item.metadata?.configRevisionId,
    rehearsalId: item.rehearsalId,
  });

  try {
    // stableUploadHeaders deliberately only serializes. Validate its result so
    // old IndexedDB rows with non-UUID ids/timestamps fall back safely.
    parseUploadHeaders(new Headers(headers));
    return headers;
  } catch (error) {
    if (error instanceof InvalidUploadHeadersError) return {};
    throw error;
  }
}
