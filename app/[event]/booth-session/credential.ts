export type StoredCredential = {
  key: string;
  persistence: "session" | "local";
};

type CredentialStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function credentialKey(event: string) {
  return `webbooth:${event}:booth-key`;
}

function read(storage: CredentialStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function remove(storage: CredentialStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // The active page keeps its in-memory key even when persistence is blocked.
  }
}

export function loadBoothCredential(
  event: string,
  session: CredentialStorage,
  local: CredentialStorage
): StoredCredential | null {
  const storageKey = credentialKey(event);
  const sessionKey = read(session, storageKey);
  if (sessionKey) return { key: sessionKey, persistence: "session" };
  const localKey = read(local, storageKey);
  return localKey ? { key: localKey, persistence: "local" } : null;
}

export function saveBoothCredential(
  event: string,
  key: string,
  remember: boolean,
  session: CredentialStorage,
  local: CredentialStorage
): void {
  const storageKey = credentialKey(event);
  const target = remember ? local : session;
  const previous = remember ? session : local;
  try {
    target.setItem(storageKey, key);
    remove(previous, storageKey);
  } catch {
    // Callers retain the submitted key in memory without claiming persistence.
  }
}

export function clearBoothCredential(
  event: string,
  session: CredentialStorage,
  local: CredentialStorage
): void {
  const storageKey = credentialKey(event);
  remove(session, storageKey);
  remove(local, storageKey);
}
