import type {
  RehearsalEvidenceInput,
  RehearsalSession,
} from "../../rehearsal";
import type { OutboxItem } from "./outbox";
import type { ClassifiedFailure } from "./session";
import {
  createRehearsalEvidenceOutbox,
  type RehearsalEvidenceOutbox,
} from "./rehearsal-evidence-outbox";

export type JoinedRehearsal = RehearsalSession & { stale: boolean };

export type RehearsalClientState = {
  rehearsal: JoinedRehearsal | null;
  pendingEvidence: number;
  durable: boolean;
  error: string | null;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type WithoutEvidenceEnvelope<T> = T extends unknown
  ? Omit<T, "version" | "id" | "rehearsalId" | "observedAt">
  : never;
type EvidenceFields = WithoutEvidenceEnvelope<RehearsalEvidenceInput>;

export class RehearsalClient {
  readonly bootId: string;
  private state: RehearsalClientState;
  private active = true;
  private recoveredIds: string[] = [];
  private acknowledgedRecovered = new Set<string>();
  private drainRecorded = false;
  private emptyRecorded = false;
  private readinessRecorded = false;
  private draining: Promise<void> | null = null;
  private listeners = new Set<(state: RehearsalClientState) => void>();

  constructor(private readonly options: {
    event: string;
    rehearsalId: string;
    key: () => string;
    outbox?: RehearsalEvidenceOutbox;
    fetch?: FetchLike;
    makeId?: () => string;
    now?: () => number;
    previousBootId?: string | null;
  }) {
    this.outbox = options.outbox ?? createRehearsalEvidenceOutbox();
    this.fetcher = options.fetch ?? fetch;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.bootId = this.makeId();
    this.state = {
      rehearsal: null,
      pendingEvidence: 0,
      durable: this.outbox.isDurable(),
      error: null,
    };
  }

  private readonly outbox: RehearsalEvidenceOutbox;
  private readonly fetcher: FetchLike;
  private readonly makeId: () => string;
  private readonly now: () => number;

  subscribe(listener: (state: RehearsalClientState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot() { return this.state; }
  rehearsalIdForNewCapture() {
    return this.active && this.state.rehearsal && !this.state.rehearsal.stale
      ? this.options.rehearsalId
      : undefined;
  }

  private publish(next: Partial<RehearsalClientState>) {
    this.state = { ...this.state, ...next, durable: this.outbox.isDurable() };
    for (const listener of this.listeners) {
      try { listener(this.state); } catch { /* UI-only */ }
    }
  }

  async join() {
    const response = await this.fetcher(
      `/api/rehearsals/join?event=${encodeURIComponent(this.options.event)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-booth-key": this.options.key(),
        },
        body: JSON.stringify({ rehearsalId: this.options.rehearsalId }),
      },
    );
    if (!response.ok) throw new Error(`Rehearsal join returned ${response.status}`);
    const payload = await response.json() as { rehearsal?: JoinedRehearsal };
    if (!payload.rehearsal || payload.rehearsal.id !== this.options.rehearsalId) {
      throw new Error("Rehearsal join response was invalid");
    }
    this.publish({ rehearsal: payload.rehearsal, error: null });
    await this.refreshPending();
  }

  async recordReadiness(input: {
    deviceId: string;
    cameraReady: boolean;
    durableStorage: boolean;
  }) {
    if (
      this.readinessRecorded
      || !this.state.rehearsal
      || !input.cameraReady
      || !input.durableStorage
    ) return;
    this.readinessRecorded = true;
    await this.queue({
      kind: "booth-ready",
      deviceId: input.deviceId,
      bootId: this.bootId,
      cameraReady: true,
      durableStorage: true,
    });
  }

  async recordUploadFailure(item: OutboxItem, failure: ClassifiedFailure) {
    if (
      item.rehearsalId !== this.options.rehearsalId
      || failure.kind !== "retryable"
      || (failure.errorClass !== "network" && failure.errorClass !== "timeout")
    ) return;
    await this.queue({
      kind: "network-failure",
      captureId: item.id,
      bootId: this.bootId,
      errorClass: failure.errorClass,
    });
  }

  async recordRecovery(items: readonly OutboxItem[]) {
    const rows = items.filter((item) => item.rehearsalId === this.options.rehearsalId);
    if (!rows.length || !this.options.previousBootId || this.options.previousBootId === this.bootId) return;
    this.recoveredIds = rows.map((item) => item.id);
    await this.queue({
      kind: "outbox-recovered",
      previousBootId: this.options.previousBootId,
      bootId: this.bootId,
      captureIds: [...this.recoveredIds],
    });
  }

  async recordAcknowledgement(item: OutboxItem) {
    if (item.rehearsalId !== this.options.rehearsalId) return;
    if (this.recoveredIds.includes(item.id)) this.acknowledgedRecovered.add(item.id);
    if (
      !this.drainRecorded
      && this.recoveredIds.length > 0
      && this.recoveredIds.every((id) => this.acknowledgedRecovered.has(id))
    ) {
      this.drainRecorded = true;
      await this.queue({
        kind: "ordered-drain",
        bootId: this.bootId,
        captureIds: [...this.recoveredIds],
      });
    }
  }

  async recordEmptyOutbox() {
    if (this.emptyRecorded) return;
    this.emptyRecorded = true;
    await this.queue({
      kind: "outbox-empty",
      bootId: this.bootId,
      pendingCount: 0,
    });
  }

  async drainEvidence() {
    if (this.draining) return this.draining;
    const run = this.drainEvidenceRows().finally(() => {
      if (this.draining === run) this.draining = null;
    });
    this.draining = run;
    return run;
  }

  private async drainEvidenceRows() {
    const rows = await this.outbox.list(this.options.event, this.options.rehearsalId);
    this.publish({ pendingEvidence: rows.length });
    for (const row of rows) {
      try {
        const response = await this.fetcher(
          `/api/rehearsals/evidence?event=${encodeURIComponent(this.options.event)}&id=${encodeURIComponent(this.options.rehearsalId)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-booth-key": this.options.key(),
            },
            body: JSON.stringify(row.evidence),
          },
        );
        if (!response.ok) throw new Error(`Evidence returned ${response.status}`);
        await this.outbox.remove(row.id);
      } catch (cause) {
        await this.outbox.put({ ...row, attempts: row.attempts + 1 });
        this.publish({
          error: cause instanceof Error ? cause.message : String(cause),
          pendingEvidence: (await this.outbox.list(this.options.event, this.options.rehearsalId)).length,
        });
        return;
      }
    }
    this.publish({ pendingEvidence: 0, error: null });
  }

  stop() { this.active = false; }

  private async queue(
    fields: EvidenceFields,
  ) {
    const id = this.makeId();
    const evidence = {
      version: 1,
      id,
      rehearsalId: this.options.rehearsalId,
      observedAt: this.now(),
      ...fields,
    } as RehearsalEvidenceInput;
    await this.outbox.put({
      id,
      event: this.options.event,
      rehearsalId: this.options.rehearsalId,
      createdAt: evidence.observedAt,
      attempts: 0,
      evidence,
    });
    await this.refreshPending();
    void this.drainEvidence();
  }

  private async refreshPending() {
    const pending = await this.outbox.list(this.options.event, this.options.rehearsalId);
    this.publish({ pendingEvidence: pending.length });
  }
}
