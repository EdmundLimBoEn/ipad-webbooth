const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i;
const MAX_IDS = 256;

export type RehearsalSession = {
  version: 1;
  id: string;
  startedAt: string;
  configRevisionId: string | null;
  frames: string[];
};

type RehearsalEvidenceBase = {
  version: 1;
  id: string;
  rehearsalId: string;
  observedAt: number;
  recordedAt: string;
};

export type RehearsalEvidence =
  | (RehearsalEvidenceBase & {
      kind: "booth-ready";
      deviceId: string;
      bootId: string;
      cameraReady: true;
      durableStorage: true;
    })
  | (RehearsalEvidenceBase & {
      kind: "network-failure";
      captureId: string;
      bootId: string;
      errorClass: "network" | "timeout";
    })
  | (RehearsalEvidenceBase & {
      kind: "outbox-recovered";
      previousBootId: string;
      bootId: string;
      captureIds: string[];
    })
  | (RehearsalEvidenceBase & {
      kind: "photo-acknowledged";
      captureId: string;
      capturedAt: number;
      frameKey?: string;
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "ordered-drain";
      bootId: string;
      captureIds: string[];
    })
  | (RehearsalEvidenceBase & {
      kind: "delivery-observed";
      photoKey: string;
      feedObserved: true;
      publicImageObserved: true;
    })
  | (RehearsalEvidenceBase & {
      kind: "canary-designated";
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "canary-deleted";
      photoKey: string;
      cleanupPending: boolean;
    })
  | (RehearsalEvidenceBase & {
      kind: "outbox-empty";
      bootId: string;
      pendingCount: 0;
    })
  | (RehearsalEvidenceBase & {
      kind: "photo-retained" | "photo-deleted";
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "manual-check";
      check: ManualCheck;
    })
  | (RehearsalEvidenceBase & {
      kind: "abandoned";
    });

export type RehearsalEvidenceInput = RehearsalEvidence extends infer Evidence
  ? Evidence extends RehearsalEvidence
    ? Omit<Evidence, "recordedAt">
    : never
  : never;

export type RehearsalRequirement =
  | "booth-ready"
  | "frames-covered"
  | "two-network-failures"
  | "reload-recovered"
  | "ordered-drain"
  | "public-delivery"
  | "canary-deleted"
  | "outbox-empty";

export type ManualCheck =
  | "composition"
  | "projector"
  | "power"
  | "charging"
  | "backup-network";

export type RehearsalSummary = {
  status: "active" | "stale" | "complete" | "abandoned";
  stale: boolean;
  requirements: Record<RehearsalRequirement, {
    complete: boolean;
    evidenceIds: string[];
  }>;
  manualChecks: Record<ManualCheck, boolean>;
  trackedPhotos: {
    captureId: string;
    frameKey?: string;
    photoKey: string;
    disposition: "pending" | "canary-deleted" | "retained" | "deleted";
  }[];
  remainingExactKeys: string[];
};

const REQUIREMENTS: readonly RehearsalRequirement[] = [
  "booth-ready",
  "frames-covered",
  "two-network-failures",
  "reload-recovered",
  "ordered-drain",
  "public-delivery",
  "canary-deleted",
  "outbox-empty",
];

const MANUAL_CHECKS: readonly ManualCheck[] = [
  "composition",
  "projector",
  "power",
  "charging",
  "backup-network",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1_000_000_000_000
    && value <= 9_999_999_999_999;
}

function isStoredInstant(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_IDS
    && value.every(isUuid)
    && new Set(value).size === value.length;
}

function isPhotoKey(value: unknown, event?: string): value is string {
  if (typeof value !== "string") return false;
  if (event !== undefined) {
    const prefix = `${event}/`;
    if (!value.startsWith(prefix)) return false;
    const filename = value.slice(prefix.length);
    return filename.length > 0
      && !/[\/\\?#]/.test(filename)
      && IMAGE_EXTENSION.test(filename);
  }
  const slash = value.indexOf("/");
  return slash > 0
    && TOKEN.test(value.slice(0, slash))
    && !/[\/\\?#]/.test(value.slice(slash + 1))
    && IMAGE_EXTENSION.test(value);
}

export function parseRehearsalSession(value: unknown): RehearsalSession | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "version",
      "id",
      "startedAt",
      "configRevisionId",
      "frames",
    ])
    || value.version !== 1
    || !isUuid(value.id)
    || !isStoredInstant(value.startedAt)
    || (value.configRevisionId !== null && !isUuid(value.configRevisionId))
    || !Array.isArray(value.frames)
    || value.frames.length > MAX_IDS
    || !value.frames.every((frame) => typeof frame === "string" && TOKEN.test(frame))
    || new Set(value.frames).size !== value.frames.length
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    startedAt: value.startedAt,
    configRevisionId: value.configRevisionId,
    frames: [...value.frames],
  };
}

export function parseRehearsalEvidence(
  value: unknown,
  event?: string,
): RehearsalEvidence | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const common = ["version", "id", "rehearsalId", "observedAt", "recordedAt", "kind"];
  if (
    value.version !== 1
    || !isUuid(value.id)
    || !isUuid(value.rehearsalId)
    || !isTimestamp(value.observedAt)
    || !isStoredInstant(value.recordedAt)
  ) {
    return null;
  }

  const base = {
    version: 1 as const,
    id: value.id,
    rehearsalId: value.rehearsalId,
    observedAt: value.observedAt,
    recordedAt: value.recordedAt,
  };
  switch (value.kind) {
    case "booth-ready":
      if (
        !hasExactKeys(value, [...common, "deviceId", "bootId", "cameraReady", "durableStorage"])
        || !isUuid(value.deviceId)
        || !isUuid(value.bootId)
        || value.cameraReady !== true
        || value.durableStorage !== true
      ) return null;
      return { ...base, kind: value.kind, deviceId: value.deviceId, bootId: value.bootId, cameraReady: true, durableStorage: true };
    case "network-failure":
      if (
        !hasExactKeys(value, [...common, "captureId", "bootId", "errorClass"])
        || !isUuid(value.captureId)
        || !isUuid(value.bootId)
        || (value.errorClass !== "network" && value.errorClass !== "timeout")
      ) return null;
      return { ...base, kind: value.kind, captureId: value.captureId, bootId: value.bootId, errorClass: value.errorClass };
    case "outbox-recovered":
      if (
        !hasExactKeys(value, [...common, "previousBootId", "bootId", "captureIds"])
        || !isUuid(value.previousBootId)
        || !isUuid(value.bootId)
        || !isIdList(value.captureIds)
      ) return null;
      return { ...base, kind: value.kind, previousBootId: value.previousBootId, bootId: value.bootId, captureIds: [...value.captureIds] };
    case "photo-acknowledged": {
      const keys = [...common, "captureId", "capturedAt", "photoKey"];
      if (Object.hasOwn(value, "frameKey")) keys.push("frameKey");
      if (
        !hasExactKeys(value, keys)
        || !isUuid(value.captureId)
        || !isTimestamp(value.capturedAt)
        || !isPhotoKey(value.photoKey, event)
        || (
          value.frameKey !== undefined
          && (typeof value.frameKey !== "string" || !TOKEN.test(value.frameKey))
        )
      ) return null;
      return {
        ...base,
        kind: value.kind,
        captureId: value.captureId,
        capturedAt: value.capturedAt,
        ...(typeof value.frameKey === "string" ? { frameKey: value.frameKey } : {}),
        photoKey: value.photoKey,
      };
    }
    case "ordered-drain":
      if (
        !hasExactKeys(value, [...common, "bootId", "captureIds"])
        || !isUuid(value.bootId)
        || !isIdList(value.captureIds)
      ) return null;
      return { ...base, kind: value.kind, bootId: value.bootId, captureIds: [...value.captureIds] };
    case "delivery-observed":
      if (
        !hasExactKeys(value, [...common, "photoKey", "feedObserved", "publicImageObserved"])
        || !isPhotoKey(value.photoKey, event)
        || value.feedObserved !== true
        || value.publicImageObserved !== true
      ) return null;
      return { ...base, kind: value.kind, photoKey: value.photoKey, feedObserved: true, publicImageObserved: true };
    case "canary-designated":
      if (!hasExactKeys(value, [...common, "photoKey"]) || !isPhotoKey(value.photoKey, event)) return null;
      return { ...base, kind: value.kind, photoKey: value.photoKey };
    case "canary-deleted":
      if (
        !hasExactKeys(value, [...common, "photoKey", "cleanupPending"])
        || !isPhotoKey(value.photoKey, event)
        || typeof value.cleanupPending !== "boolean"
      ) return null;
      return { ...base, kind: value.kind, photoKey: value.photoKey, cleanupPending: value.cleanupPending };
    case "outbox-empty":
      if (
        !hasExactKeys(value, [...common, "bootId", "pendingCount"])
        || !isUuid(value.bootId)
        || value.pendingCount !== 0
      ) return null;
      return { ...base, kind: value.kind, bootId: value.bootId, pendingCount: 0 };
    case "photo-retained":
    case "photo-deleted":
      if (!hasExactKeys(value, [...common, "photoKey"]) || !isPhotoKey(value.photoKey, event)) return null;
      return { ...base, kind: value.kind, photoKey: value.photoKey };
    case "manual-check":
      if (
        !hasExactKeys(value, [...common, "check"])
        || typeof value.check !== "string"
        || !(MANUAL_CHECKS as readonly string[]).includes(value.check)
      ) return null;
      return { ...base, kind: value.kind, check: value.check as ManualCheck };
    case "abandoned":
      return hasExactKeys(value, common) ? { ...base, kind: value.kind } : null;
    default:
      return null;
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function reduceRehearsal(input: {
  session: RehearsalSession;
  evidence: readonly RehearsalEvidence[];
  currentRevisionId: string | null;
}): RehearsalSummary {
  const records = [...input.evidence].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id)
  );
  const requirements = Object.fromEntries(REQUIREMENTS.map((requirement) => [
    requirement,
    { complete: false, evidenceIds: [] as string[] },
  ])) as RehearsalSummary["requirements"];
  const manualChecks = Object.fromEntries(
    MANUAL_CHECKS.map((check) => [check, false]),
  ) as RehearsalSummary["manualChecks"];

  const ready = records.filter((record) => record.kind === "booth-ready");
  if (ready.length > 0) {
    requirements["booth-ready"] = {
      complete: true,
      evidenceIds: ready.map(({ id }) => id),
    };
  }

  const acknowledged = records.filter(
    (record): record is Extract<RehearsalEvidence, { kind: "photo-acknowledged" }> =>
      record.kind === "photo-acknowledged",
  );
  const acknowledgementsByCapture = new Map<string, typeof acknowledged[number]>();
  const acknowledgementsByKey = new Map<string, typeof acknowledged[number]>();
  for (const record of acknowledged) {
    if (!acknowledgementsByCapture.has(record.captureId)) {
      acknowledgementsByCapture.set(record.captureId, record);
    }
    if (!acknowledgementsByKey.has(record.photoKey)) {
      acknowledgementsByKey.set(record.photoKey, record);
    }
  }
  const frameEvidence = input.session.frames.map((frame) =>
    acknowledged.find((record) => record.frameKey === frame)
  );
  if (frameEvidence.every(Boolean)) {
    requirements["frames-covered"] = {
      complete: true,
      evidenceIds: [...new Set(frameEvidence.map((record) => record!.id))],
    };
  }

  const failures = records.filter(
    (record): record is Extract<RehearsalEvidence, { kind: "network-failure" }> =>
      record.kind === "network-failure",
  );
  const failuresByCapture = new Map<string, typeof failures[number]>();
  for (const failure of failures) {
    if (!failuresByCapture.has(failure.captureId)) failuresByCapture.set(failure.captureId, failure);
  }
  const distinctFailures = [...failuresByCapture.values()];
  if (distinctFailures.length >= 2) {
    requirements["two-network-failures"] = {
      complete: true,
      evidenceIds: distinctFailures.map(({ id }) => id),
    };
  }

  const recovered = records.filter(
    (record): record is Extract<RehearsalEvidence, { kind: "outbox-recovered" }> =>
      record.kind === "outbox-recovered",
  );
  const validRecovery = recovered.find((record) =>
    distinctFailures.length >= 2
    && distinctFailures.every((failure) =>
      record.captureIds.includes(failure.captureId)
      && record.bootId !== failure.bootId
    )
  );
  if (validRecovery) {
    requirements["reload-recovered"] = {
      complete: true,
      evidenceIds: [
        ...distinctFailures.map(({ id }) => id),
        validRecovery.id,
      ],
    };
  }

  const drains = records.filter(
    (record): record is Extract<RehearsalEvidence, { kind: "ordered-drain" }> =>
      record.kind === "ordered-drain",
  );
  const validDrain = validRecovery && drains.find((record) =>
    record.bootId === validRecovery.bootId
    && sameOrder(record.captureIds, validRecovery.captureIds)
    && record.captureIds.every((captureId) => acknowledgementsByCapture.has(captureId))
  );
  if (validRecovery && validDrain) {
    requirements["ordered-drain"] = {
      complete: true,
      evidenceIds: [
        validRecovery.id,
        validDrain.id,
        ...validDrain.captureIds.map((captureId) => acknowledgementsByCapture.get(captureId)!.id),
      ],
    };
  }

  const delivery = records.find(
    (record): record is Extract<RehearsalEvidence, { kind: "delivery-observed" }> =>
      record.kind === "delivery-observed" && acknowledgementsByKey.has(record.photoKey),
  );
  if (delivery) {
    requirements["public-delivery"] = {
      complete: true,
      evidenceIds: [acknowledgementsByKey.get(delivery.photoKey)!.id, delivery.id],
    };
  }

  const designations = records.filter(
    (record): record is Extract<RehearsalEvidence, { kind: "canary-designated" }> =>
      record.kind === "canary-designated" && acknowledgementsByKey.has(record.photoKey),
  );
  const deletedCanary = records.find(
    (record): record is Extract<RehearsalEvidence, { kind: "canary-deleted" }> =>
      record.kind === "canary-deleted"
      && designations.some((designation) => designation.photoKey === record.photoKey),
  );
  if (deletedCanary) {
    const designation = designations.find(({ photoKey }) => photoKey === deletedCanary.photoKey)!;
    requirements["canary-deleted"] = {
      complete: true,
      evidenceIds: [
        acknowledgementsByKey.get(deletedCanary.photoKey)!.id,
        designation.id,
        deletedCanary.id,
      ],
    };
  }

  const empty = records.filter((record) => record.kind === "outbox-empty");
  if (empty.length > 0) {
    requirements["outbox-empty"] = {
      complete: true,
      evidenceIds: empty.map(({ id }) => id),
    };
  }
  for (const record of records) {
    if (record.kind === "manual-check") manualChecks[record.check] = true;
  }

  const retained = new Set(records.flatMap((record) =>
    record.kind === "photo-retained" ? [record.photoKey] : []
  ));
  const deleted = new Set(records.flatMap((record) =>
    record.kind === "photo-deleted" ? [record.photoKey] : []
  ));
  const trackedPhotos = [...acknowledgementsByCapture.values()].map((record) => {
    const disposition = deletedCanary?.photoKey === record.photoKey
      ? "canary-deleted" as const
      : retained.has(record.photoKey)
        ? "retained" as const
        : deleted.has(record.photoKey)
          ? "deleted" as const
          : "pending" as const;
    return {
      captureId: record.captureId,
      ...(record.frameKey ? { frameKey: record.frameKey } : {}),
      photoKey: record.photoKey,
      disposition,
    };
  });
  const remainingExactKeys = trackedPhotos
    .filter(({ disposition }) => disposition === "pending")
    .map(({ photoKey }) => photoKey);
  const stale = input.session.configRevisionId !== input.currentRevisionId;
  const complete = REQUIREMENTS.every((requirement) => requirements[requirement].complete);
  const abandoned = records.some((record) => record.kind === "abandoned");
  return {
    status: abandoned ? "abandoned" : stale ? "stale" : complete ? "complete" : "active",
    stale,
    requirements,
    manualChecks,
    trackedPhotos,
    remainingExactKeys,
  };
}
