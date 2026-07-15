export type OutboxItem = {
  id: string;
  event: string;
  blob: Blob;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

export interface OutboxStore {
  isDurable(): boolean;
  list(event: string): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, OutboxItem>();

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
}

class IndexedDbOutboxStore implements OutboxStore {
  private dbPromise: Promise<IDBDatabase>;

  isDurable() {
    return true;
  }

  constructor(indexedDB: IDBFactory) {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("ipad-webbooth", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("photo-outbox")) {
          request.result.createObjectStore("photo-outbox", { keyPath: "id" });
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
  };
}
