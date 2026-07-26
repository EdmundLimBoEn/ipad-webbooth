import {
  parseBoothHeartbeatRecord,
  parseBoothOperationalState,
  type AdminBoothRecord,
  type BoothOperationalState,
  type BoothOperationalStateInput,
} from "../../booth-control";

export type AdminBoothPage = {
  booths: AdminBoothRecord[];
  cursor: string | null;
};

export type BoothRequestTicket = Readonly<{
  generation: number;
  mutationEpoch: number;
  kind: "read" | "mutation";
  signal: AbortSignal;
}>;

type ActiveBoothRequest = BoothRequestTicket & {
  controller: AbortController;
};

export class BoothOperationsCoordinator {
  private generation = 0;
  private mutationEpoch = 0;
  private active = false;
  private scopeEvent: string | null = null;
  private scopeAdminKey: string | null = null;
  private activeRead: ActiveBoothRequest | null = null;
  private activeMutation: ActiveBoothRequest | null = null;
  private tailInitialized = false;
  private loadedTailCursor: string | null = null;

  activateScope(event: string, adminKey: string): void {
    this.abortActiveRequests();
    this.generation += 1;
    this.mutationEpoch = 0;
    this.active = true;
    this.scopeEvent = event;
    this.scopeAdminKey = adminKey;
    this.tailInitialized = false;
    this.loadedTailCursor = null;
  }

  disposeScope(): void {
    this.abortActiveRequests();
    this.generation += 1;
    this.active = false;
    this.scopeEvent = null;
    this.scopeAdminKey = null;
    this.tailInitialized = false;
    this.loadedTailCursor = null;
  }

  beginRead(event: string, adminKey: string): BoothRequestTicket | null {
    if (
      !this.matchesScope(event, adminKey)
      || this.activeRead
      || this.activeMutation
    ) return null;
    const request = this.newRequest("read");
    this.activeRead = request;
    return request;
  }

  isReadCurrent(ticket: BoothRequestTicket): boolean {
    return (
      ticket.kind === "read"
      && ticket === this.activeRead
      && ticket.generation === this.generation
      && ticket.mutationEpoch === this.mutationEpoch
      && !ticket.signal.aborted
    );
  }

  finishRead(ticket: BoothRequestTicket): boolean {
    const current = this.isReadCurrent(ticket);
    if (ticket === this.activeRead) this.activeRead = null;
    return current;
  }

  beginMutation(
    event: string,
    adminKey: string
  ): { ticket: BoothRequestTicket; abortedRead: boolean } | null {
    if (!this.matchesScope(event, adminKey) || this.activeMutation) return null;
    const abortedRead = this.activeRead !== null;
    this.activeRead?.controller.abort();
    this.activeRead = null;
    this.mutationEpoch += 1;
    const ticket = this.newRequest("mutation");
    this.activeMutation = ticket;
    return { ticket, abortedRead };
  }

  isMutationCurrent(ticket: BoothRequestTicket): boolean {
    return (
      ticket.kind === "mutation"
      && ticket === this.activeMutation
      && ticket.generation === this.generation
      && ticket.mutationEpoch === this.mutationEpoch
      && !ticket.signal.aborted
    );
  }

  finishMutation(ticket: BoothRequestTicket): boolean {
    const current = this.isMutationCurrent(ticket);
    if (ticket === this.activeMutation) this.activeMutation = null;
    return current;
  }

  acceptFirstPage(ticket: BoothRequestTicket, cursor: string | null): string | null {
    if (this.isReadCurrent(ticket) && !this.tailInitialized) {
      this.tailInitialized = true;
      this.loadedTailCursor = cursor;
    }
    return this.loadedTailCursor;
  }

  advanceTail(ticket: BoothRequestTicket, cursor: string | null): string | null {
    if (this.isReadCurrent(ticket)) {
      this.tailInitialized = true;
      this.loadedTailCursor = cursor;
    }
    return this.loadedTailCursor;
  }

  tailCursor(): string | null {
    return this.loadedTailCursor;
  }

  private newRequest(kind: "read" | "mutation"): ActiveBoothRequest {
    const controller = new AbortController();
    return {
      generation: this.generation,
      mutationEpoch: this.mutationEpoch,
      kind,
      signal: controller.signal,
      controller,
    };
  }

  private abortActiveRequests(): void {
    this.activeRead?.controller.abort();
    this.activeMutation?.controller.abort();
    this.activeRead = null;
    this.activeMutation = null;
  }

  private matchesScope(event: string, adminKey: string): boolean {
    return (
      this.active
      && event === this.scopeEvent
      && adminKey === this.scopeAdminKey
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseBoothOperationalStateResponse(
  value: unknown
): BoothOperationalState | null {
  return parseBoothOperationalState(value);
}

function parseAdminBoothRecord(value: unknown): AdminBoothRecord | null {
  if (!isPlainRecord(value) || typeof value.stale !== "boolean") return null;
  const { stale, ...heartbeatValue } = value;
  const heartbeat = parseBoothHeartbeatRecord(heartbeatValue);
  return heartbeat ? { ...heartbeat, stale } : null;
}

export function parseAdminBoothPage(value: unknown): AdminBoothPage | null {
  if (
    !isPlainRecord(value)
    || Object.keys(value).some((key) => key !== "booths" && key !== "cursor")
    || !Object.hasOwn(value, "booths")
    || !Object.hasOwn(value, "cursor")
    || !Array.isArray(value.booths)
    || (value.cursor !== null && typeof value.cursor !== "string")
  ) return null;

  const booths: AdminBoothRecord[] = [];
  for (const candidate of value.booths) {
    const booth = parseAdminBoothRecord(candidate);
    if (!booth) return null;
    booths.push(booth);
  }
  return { booths, cursor: value.cursor };
}

function parsedLastSeenAt(record: AdminBoothRecord): number | null {
  const timestamp = Date.parse(record.lastSeenAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

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
      const incomingTimestamp = parsedLastSeenAt(record);
      const currentTimestamp = current ? parsedLastSeenAt(current) : null;
      if (
        !current
        || (
          incomingTimestamp !== null
          && (currentTimestamp === null || incomingTimestamp > currentTimestamp)
        )
      ) {
        byDeviceId.set(record.deviceId, record);
      }
    }
  }

  return [...byDeviceId.values()].sort((left, right) => {
    const leftTimestamp = parsedLastSeenAt(left);
    const rightTimestamp = parsedLastSeenAt(right);
    if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
    if (rightTimestamp === null) return -1;
    return rightTimestamp - leftTimestamp;
  });
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
