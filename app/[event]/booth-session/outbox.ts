import type { CaptureMetadata } from "../../upload-contract";
import type { UploadErrorClass } from "./retry-policy";

export type OutboxItem = {
  id: string;
  event: string;
  blob: Blob;
  createdAt: number;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
  failureKind?: "retryable" | "permanent" | "auth";
  errorClass?: UploadErrorClass;
  /** Optional so rows saved by earlier Booth versions remain readable. */
  metadata?: CaptureMetadata;
  /** Reserved for the operator rehearsal flow; durable rows retain it verbatim. */
  rehearsalId?: string;
};

export interface OutboxStore {
  isDurable(): boolean;
  list(event: string): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
  acquireLease(event: string, ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  renewLease(event: string, ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  releaseLease(event: string, ownerId: string): Promise<void>;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, OutboxItem>();
  private readonly leases = new Map<string, { ownerId: string; expiresAt: number }>();

  isDurable() {
    return false;
  }

  async list(event: string) {
    return [...this.items.values()]
      .filter((item) => item.event === event)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async put(item: OutboxItem) {
    this.items.set(item.id, item);
  }

  async remove(id: string) {
    this.items.delete(id);
  }

  async acquireLease(event: string, ownerId: string, now: number, ttlMs: number) {
    const lease = this.leases.get(event);
    if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) return false;
    this.leases.set(event, { ownerId, expiresAt: now + ttlMs });
    return true;
  }

  async renewLease(event: string, ownerId: string, now: number, ttlMs: number) {
    const lease = this.leases.get(event);
    if (!lease || lease.ownerId !== ownerId) return false;
    this.leases.set(event, { ownerId, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLease(event: string, ownerId: string) {
    if (this.leases.get(event)?.ownerId === ownerId) this.leases.delete(event);
  }
}

type LeaseRecord = {
  event: string;
  ownerId: string;
  expiresAt: number;
};

class IndexedDbOutboxStore implements OutboxStore {
  private dbPromise: Promise<IDBDatabase>;

  isDurable() {
    return true;
  }

  constructor(indexedDB: IDBFactory) {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("ipad-webbooth", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("photo-outbox")) {
          request.result.createObjectStore("photo-outbox", { keyPath: "id" });
        }
        if (!request.result.objectStoreNames.contains("photo-outbox-leases")) {
          request.result.createObjectStore("photo-outbox-leases", { keyPath: "event" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open photo outbox"));
      request.onblocked = () => reject(new Error("Photo outbox upgrade was blocked"));
    });
  }

  private async request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.dbPromise;
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox", mode);
      const request = run(transaction.objectStore("photo-outbox"));
      let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("Photo outbox request failed"));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Photo outbox transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Photo outbox transaction aborted"));
    });
  }

  async list(event: string) {
    const items = await this.request<OutboxItem[]>("readonly", (store) => store.getAll());
    return items
      .filter((item) => item.event === event)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async put(item: OutboxItem) {
    await this.request("readwrite", (store) => store.put(item));
  }

  async remove(id: string) {
    await this.request("readwrite", (store) => store.delete(id));
  }

  private async leaseTransaction(
    event: string,
    update: (current: LeaseRecord | undefined, store: IDBObjectStore) => boolean
  ) {
    const db = await this.dbPromise;
    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction("photo-outbox-leases", "readwrite");
      const store = transaction.objectStore("photo-outbox-leases");
      const request = store.get(event);
      let result = false;
      request.onsuccess = () => {
        result = update(request.result as LeaseRecord | undefined, store);
      };
      request.onerror = () => {
        transaction.abort();
        reject(request.error ?? new Error("Photo outbox lease request failed"));
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(
        transaction.error ?? new Error("Photo outbox lease transaction failed")
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("Photo outbox lease transaction aborted")
      );
    });
  }

  acquireLease(event: string, ownerId: string, now: number, ttlMs: number) {
    return this.leaseTransaction(event, (current, store) => {
      if (current && current.ownerId !== ownerId && current.expiresAt > now) return false;
      store.put({ event, ownerId, expiresAt: now + ttlMs } satisfies LeaseRecord);
      return true;
    });
  }

  renewLease(event: string, ownerId: string, now: number, ttlMs: number) {
    return this.leaseTransaction(event, (current, store) => {
      if (!current || current.ownerId !== ownerId) return false;
      store.put({ event, ownerId, expiresAt: now + ttlMs } satisfies LeaseRecord);
      return true;
    });
  }

  async releaseLease(event: string, ownerId: string) {
    await this.leaseTransaction(event, (current, store) => {
      if (current?.ownerId === ownerId) store.delete(event);
      return current?.ownerId === ownerId;
    });
  }
}

/** Uses IndexedDB when available, but keeps the booth usable in private/locked-down browsers. */
export function createOutboxStore(
  factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB
): OutboxStore {
  const memory = new MemoryOutboxStore();
  if (!factory) return memory;

  const durable = new IndexedDbOutboxStore(factory);
  let usingMemory = false;
  const fallback = async <T>(durableWork: () => Promise<T>, memoryWork: () => Promise<T>) => {
    if (usingMemory) return memoryWork();
    try {
      return await durableWork();
    } catch {
      usingMemory = true;
      return memoryWork();
    }
  };
  return {
    isDurable: () => !usingMemory,
    list: (event) => fallback(async () => {
      const items = await durable.list(event);
      await Promise.all(items.map((item) => memory.put(item)));
      return items;
    }, () => memory.list(event)),
    put: async (item) => {
      // Mirror current-session items so a later IndexedDB failure cannot lose them.
      await memory.put(item);
      await fallback(() => durable.put(item), () => Promise.resolve());
    },
    remove: async (id) => {
      await memory.remove(id);
      await fallback(() => durable.remove(id), () => Promise.resolve());
    },
    acquireLease: (event, ownerId, now, ttlMs) => fallback(
      () => durable.acquireLease(event, ownerId, now, ttlMs),
      () => memory.acquireLease(event, ownerId, now, ttlMs)
    ),
    renewLease: (event, ownerId, now, ttlMs) => fallback(
      () => durable.renewLease(event, ownerId, now, ttlMs),
      () => memory.renewLease(event, ownerId, now, ttlMs)
    ),
    releaseLease: (event, ownerId) => fallback(
      () => durable.releaseLease(event, ownerId),
      () => memory.releaseLease(event, ownerId)
    ),
  };
}
