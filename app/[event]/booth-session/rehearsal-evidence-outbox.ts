import type { RehearsalEvidenceInput } from "../../rehearsal";

export type PendingRehearsalEvidence = {
  id: string;
  event: string;
  rehearsalId: string;
  createdAt: number;
  attempts: number;
  evidence: RehearsalEvidenceInput;
};

export interface RehearsalEvidenceOutbox {
  isDurable(): boolean;
  list(event: string, rehearsalId: string): Promise<PendingRehearsalEvidence[]>;
  put(item: PendingRehearsalEvidence): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryRehearsalEvidenceOutbox implements RehearsalEvidenceOutbox {
  private readonly rows = new Map<string, PendingRehearsalEvidence>();
  isDurable() { return false; }
  async list(event: string, rehearsalId: string) {
    return [...this.rows.values()]
      .filter((row) => row.event === event && row.rehearsalId === rehearsalId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async put(item: PendingRehearsalEvidence) { this.rows.set(item.id, item); }
  async remove(id: string) { this.rows.delete(id); }
}

class IndexedDbRehearsalEvidenceOutbox implements RehearsalEvidenceOutbox {
  private readonly db: Promise<IDBDatabase>;
  isDurable() { return true; }

  constructor(factory: IDBFactory) {
    this.db = new Promise((resolve, reject) => {
      const request = factory.open("ipad-webbooth-rehearsal", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("evidence-outbox")) {
          request.result.createObjectStore("evidence-outbox", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open rehearsal evidence outbox"));
      request.onblocked = () => reject(new Error("Rehearsal evidence outbox upgrade was blocked"));
    });
  }

  private async request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("evidence-outbox", mode);
      const request = run(transaction.objectStore("evidence-outbox"));
      let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("Rehearsal evidence request failed"));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Rehearsal evidence transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Rehearsal evidence transaction aborted"));
    });
  }

  async list(event: string, rehearsalId: string) {
    const rows = await this.request<PendingRehearsalEvidence[]>("readonly", (store) => store.getAll());
    return rows
      .filter((row) => row.event === event && row.rehearsalId === rehearsalId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async put(item: PendingRehearsalEvidence) {
    await this.request("readwrite", (store) => store.put(item));
  }
  async remove(id: string) {
    await this.request("readwrite", (store) => store.delete(id));
  }
}

export function createRehearsalEvidenceOutbox(
  factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB,
): RehearsalEvidenceOutbox {
  const memory = new MemoryRehearsalEvidenceOutbox();
  if (!factory) return memory;
  const durable = new IndexedDbRehearsalEvidenceOutbox(factory);
  let degraded = false;
  const fallback = async <T>(durableWork: () => Promise<T>, memoryWork: () => Promise<T>) => {
    if (degraded) return memoryWork();
    try {
      return await durableWork();
    } catch {
      degraded = true;
      return memoryWork();
    }
  };
  return {
    isDurable: () => !degraded,
    list: (event, rehearsalId) => fallback(async () => {
      const rows = await durable.list(event, rehearsalId);
      await Promise.all(rows.map((row) => memory.put(row)));
      return rows;
    }, () => memory.list(event, rehearsalId)),
    put: async (item) => {
      await memory.put(item);
      await fallback(() => durable.put(item), () => Promise.resolve());
    },
    remove: async (id) => {
      if (degraded) {
        await memory.remove(id);
        return;
      }
      try {
        await durable.remove(id);
        await memory.remove(id);
      } catch {
        degraded = true;
        // Keep the mirrored row: a failed durable acknowledgement must remain
        // visible to this page and is safe to retry by stable evidence ID.
      }
    },
  };
}
