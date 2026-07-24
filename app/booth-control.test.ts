import { describe, expect, test } from "bun:test";
import {
  parseBoothHeartbeat,
  parseBoothHeartbeatRecord,
  parseBoothOperationalState,
} from "./booth-control";

const heartbeat = {
  version: 1,
  deviceId: "018f0000-0000-4000-8000-000000000001",
  sessionStartedAt: 1753315200000,
  pendingCount: 2,
  durableStorage: true,
  online: true,
  installed: true,
  camera: "ready",
  upload: "retry-wait",
  buildId: "release_1",
} as const;

describe("Booth control schemas", () => {
  test("parses a bounded heartbeat without arbitrary error text", () => {
    expect(parseBoothHeartbeat(heartbeat)).toEqual(heartbeat);
    expect(parseBoothHeartbeat({
      ...heartbeat,
      pendingCount: 0,
      installed: false,
      upload: "idle",
      error: "credential=x",
    })).toBeNull();
  });

  test("rejects unknown, future, or unbounded heartbeat fields", () => {
    expect(parseBoothHeartbeat({ ...heartbeat, version: 2 })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, deviceId: heartbeat.deviceId.toUpperCase() })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, sessionStartedAt: 1.5 })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, pendingCount: 10_001 })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, buildId: "x".repeat(129) })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, camera: "exception: credential=x" })).toBeNull();
    expect(parseBoothHeartbeat({ ...heartbeat, unexpected: true })).toBeNull();
  });

  test("parses only server-timestamped stored heartbeat records", () => {
    const stored = { ...heartbeat, lastSeenAt: "2026-07-24T00:00:00.000Z" };
    expect(parseBoothHeartbeatRecord(stored)).toEqual(stored);
    expect(parseBoothHeartbeatRecord({ ...stored, lastSeenAt: "not-a-date" })).toBeNull();
    expect(parseBoothHeartbeatRecord({ ...stored, version: 2 })).toBeNull();
  });

  test("parses at most twenty bounded localized pause messages", () => {
    const state = {
      version: 1 as const,
      paused: true,
      messages: { en: "The Booth is briefly paused.", "zh-SG": "暂时暂停" },
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    expect(parseBoothOperationalState(state)).toEqual(state);
    expect(parseBoothOperationalState({ ...state, messages: { "en<script>": "unsafe" } })).toBeNull();
    expect(parseBoothOperationalState({ ...state, messages: { en: "x".repeat(281) } })).toBeNull();
    expect(parseBoothOperationalState({
      ...state,
      messages: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`l${index}`, "paused"])),
    })).toBeNull();
    expect(parseBoothOperationalState({ ...state, unknown: "credential=x" })).toBeNull();
  });
});
