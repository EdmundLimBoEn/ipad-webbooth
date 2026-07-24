const DEVICE_ID_KEY = "webbooth:device-id";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A blocked localStorage implementation cannot persist across a reload, but it
// can still keep one stable identity for this page's browser session.
const sessionOnlyIds = new WeakMap<object, string>();

export function loadOrCreateDeviceId(
  storage: Pick<Storage, "getItem" | "setItem">,
  makeId: () => string = () => crypto.randomUUID()
): string {
  const sessionOnly = sessionOnlyIds.get(storage);
  if (sessionOnly) return sessionOnly;

  let generated: string | null = null;
  try {
    const stored = storage.getItem(DEVICE_ID_KEY);
    if (stored && UUID_V4.test(stored)) return stored;

    generated = makeId().toLowerCase();
    storage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    const deviceId = generated ?? makeId().toLowerCase();
    sessionOnlyIds.set(storage, deviceId);
    return deviceId;
  }
}
