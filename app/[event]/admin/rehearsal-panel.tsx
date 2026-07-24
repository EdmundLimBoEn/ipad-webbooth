"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  type ManualCheck,
  type RehearsalEvidenceInput,
  type RehearsalRequirement,
  type RehearsalSession,
  type RehearsalSummary,
} from "../../rehearsal";
import { message, type SupportedLocale } from "../../i18n/catalog";
import styles from "./admin.module.css";

type RehearsalView = {
  session: RehearsalSession;
  summary: RehearsalSummary;
};
type WithoutEvidenceEnvelope<T> = T extends unknown
  ? Omit<T, "version" | "id" | "rehearsalId" | "observedAt">
  : never;
type EvidenceFields = WithoutEvidenceEnvelope<RehearsalEvidenceInput>;
type ConfirmedDeletion = {
  kind: "canary" | "delete";
  cleanupPending: boolean;
};

const requirements: RehearsalRequirement[] = [
  "booth-ready", "frames-covered", "two-network-failures", "reload-recovered",
  "ordered-drain", "public-delivery", "canary-deleted", "outbox-empty",
];
const manualChecks: ManualCheck[] = [
  "composition", "projector", "power", "charging", "backup-network",
];

const requirementKeys: Record<RehearsalRequirement, Parameters<typeof message>[1]> = {
  "booth-ready": "rehearsalReqBoothReady",
  "frames-covered": "rehearsalReqFrames",
  "two-network-failures": "rehearsalReqFailures",
  "reload-recovered": "rehearsalReqReload",
  "ordered-drain": "rehearsalReqDrain",
  "public-delivery": "rehearsalReqDelivery",
  "canary-deleted": "rehearsalReqCanary",
  "outbox-empty": "rehearsalReqEmpty",
};
const manualKeys: Record<ManualCheck, Parameters<typeof message>[1]> = {
  composition: "rehearsalManualComposition",
  projector: "rehearsalManualProjector",
  power: "rehearsalManualPower",
  charging: "rehearsalManualCharging",
  "backup-network": "rehearsalManualBackup",
};

export function RehearsalPanel({
  event,
  adminKey,
  locale,
  origin,
  onUnauthorized,
}: {
  event: string;
  adminKey: string;
  locale: SupportedLocale;
  origin: string;
  onUnauthorized: () => void;
}) {
  const [view, setView] = useState<RehearsalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmCanary, setConfirmCanary] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readInFlight = useRef(false);
  const stopped = useRef(false);
  const confirmedDeletes = useRef(new Map<string, ConfirmedDeletion>());
  const confirmedDeleteScope = useRef("");
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);

  const label = useCallback(
    (key: Parameters<typeof message>[1], values?: Record<string, string | number>) =>
      message(locale, key, values),
    [locale],
  );
  const rehearsalUrl = view && origin
    ? `${origin}/${event}?rehearsal=${encodeURIComponent(view.session.id)}`
    : "";

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: {
        ...init?.headers,
        "x-booth-key": adminKey,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error(label("rehearsalUnauthorized"));
    }
    return response;
  }, [adminKey, label, onUnauthorized]);

  const load = useCallback(async () => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    if (timer.current) clearTimeout(timer.current);
    try {
      const response = await request(`/api/rehearsals?event=${encodeURIComponent(event)}`);
      if (response.status === 404) {
        if (!stopped.current) setView(null);
        return;
      }
      if (!response.ok) throw new Error(label("rehearsalLoadError"));
      const payload = await response.json() as { rehearsal?: RehearsalView };
      if (!payload.rehearsal?.session || !payload.rehearsal.summary) {
        throw new Error(label("rehearsalLoadError"));
      }
      if (!stopped.current) {
        setView(payload.rehearsal);
        setError("");
      }
    } catch (cause) {
      if (!stopped.current) setError(cause instanceof Error ? cause.message : label("rehearsalLoadError"));
    } finally {
      readInFlight.current = false;
      if (!stopped.current) {
        setLoading(false);
        timer.current = setTimeout(() => void load(), 5_000);
      }
    }
  }, [event, label, request]);

  useEffect(() => {
    stopped.current = false;
    void load();
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    if (!rehearsalUrl) { setQr(""); return; }
    void QRCode.toDataURL(rehearsalUrl, { width: 200, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [rehearsalUrl]);

  const start = async () => {
    setBusy("start"); setError("");
    try {
      const id = crypto.randomUUID();
      const response = await request(`/api/rehearsals?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rehearsalId: id }),
      });
      if (!response.ok) throw new Error(label("rehearsalStartError"));
      setConfirmStart(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : label("rehearsalStartError"));
    } finally { setBusy(""); }
  };

  const append = async (
    fields: EvidenceFields,
  ) => {
    if (!view) return;
    const response = await request(
      `/api/rehearsals/evidence?event=${encodeURIComponent(event)}&id=${encodeURIComponent(view.session.id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          id: crypto.randomUUID(),
          rehearsalId: view.session.id,
          observedAt: Date.now(),
          ...fields,
        }),
      },
    );
    if (!response.ok) throw new Error(label("rehearsalActionError"));
    await load();
  };

  const confirmedDeleteMap = () => {
    if (!view) return confirmedDeletes.current;
    const scope = `webbooth:${event}:rehearsal:${view.session.id}:confirmed-deletes`;
    if (confirmedDeleteScope.current === scope) return confirmedDeletes.current;
    confirmedDeleteScope.current = scope;
    confirmedDeletes.current.clear();
    try {
      const stored = JSON.parse(window.localStorage.getItem(scope) ?? "[]") as unknown;
      if (Array.isArray(stored)) {
        for (const entry of stored) {
          if (
            Array.isArray(entry)
            && entry.length === 3
            && typeof entry[0] === "string"
            && (entry[1] === "canary" || entry[1] === "delete")
            && typeof entry[2] === "boolean"
          ) {
            confirmedDeletes.current.set(entry[0], {
              kind: entry[1],
              cleanupPending: entry[2],
            });
          }
        }
      }
    } catch {
      // The in-memory marker still prevents a repeated delete in this page.
    }
    return confirmedDeletes.current;
  };

  const persistConfirmedDeletes = () => {
    if (!confirmedDeleteScope.current) return;
    try {
      window.localStorage.setItem(
        confirmedDeleteScope.current,
        JSON.stringify([...confirmedDeletes.current].map(([key, value]) => [
          key,
          value.kind,
          value.cleanupPending,
        ])),
      );
    } catch {
      // Storage denial is visible operationally through a retained in-page marker.
    }
  };

  const deletePublicPhoto = async (
    photoKey: string,
    kind: ConfirmedDeletion["kind"],
  ) => {
    const retained = confirmedDeleteMap().get(photoKey);
    if (retained) {
      if (retained.kind !== kind) throw new Error(label("rehearsalActionError"));
      return retained.cleanupPending;
    }
    const query = new URLSearchParams({ event, key: photoKey });
    const response = await request(`/api/photos?${query}`, { method: "DELETE" });
    const result = await response.json() as {
      deleted?: unknown;
      cleanupPending?: unknown;
      key?: unknown;
    };
    if (
      !response.ok
      || result.deleted !== true
      || result.key !== photoKey
      || typeof result.cleanupPending !== "boolean"
    ) {
      throw new Error(label("rehearsalActionError"));
    }
    const confirmed = {
      kind,
      cleanupPending: result.cleanupPending,
    } satisfies ConfirmedDeletion;
    confirmedDeleteMap().set(photoKey, confirmed);
    persistConfirmedDeletes();
    return confirmed.cleanupPending;
  };

  const clearConfirmedDelete = (photoKey: string) => {
    confirmedDeleteMap().delete(photoKey);
    persistConfirmedDeletes();
  };

  const disposition = async (photoKey: string, action: "retain" | "delete") => {
    setBusy(`${action}:${photoKey}`); setError("");
    try {
      if (action === "delete") {
        await deletePublicPhoto(photoKey, "delete");
      } else if (confirmedDeleteMap().has(photoKey)) {
        throw new Error(label("rehearsalActionError"));
      }
      await append({ kind: action === "retain" ? "photo-retained" : "photo-deleted", photoKey });
      if (action === "delete") clearConfirmedDelete(photoKey);
      setConfirmDelete(null);
      requestAnimationFrame(() => deleteTrigger.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : label("rehearsalActionError"));
    } finally { setBusy(""); }
  };

  const observeDelivery = async (photoKey: string) => {
    setBusy("delivery"); setError("");
    try {
      const response = await fetch(`/api/photos?event=${encodeURIComponent(event)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(label("rehearsalDeliveryError"));
      const payload = await response.json() as { photos?: { key: string; url: string }[] };
      const exact = payload.photos?.find((photo) => photo.key === photoKey);
      if (!exact) throw new Error(label("rehearsalDeliveryError"));
      const image = await fetch(exact.url, { cache: "no-store" });
      if (!image.ok || (await image.arrayBuffer()).byteLength === 0) {
        throw new Error(label("rehearsalDeliveryError"));
      }
      await append({ kind: "delivery-observed", photoKey, feedObserved: true, publicImageObserved: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : label("rehearsalDeliveryError"));
    } finally { setBusy(""); }
  };

  const deleteCanary = async (photoKey: string) => {
    setBusy("canary"); setError("");
    try {
      const retained = confirmedDeleteMap().get(photoKey);
      if (retained?.kind !== "canary") {
        if (retained) throw new Error(label("rehearsalActionError"));
        await append({ kind: "canary-designated", photoKey });
      }
      const cleanupPending = await deletePublicPhoto(photoKey, "canary");
      await append({ kind: "canary-deleted", photoKey, cleanupPending });
      clearConfirmedDelete(photoKey);
      setConfirmCanary(null);
      requestAnimationFrame(() => deleteTrigger.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : label("rehearsalActionError"));
    } finally { setBusy(""); }
  };

  return (
    <section className={styles.rehearsalPanel} aria-labelledby="rehearsal-panel-title">
      <div className={styles.rehearsalHead}>
        <div>
          <span>04 / {label("rehearsalOperatorContext")}</span>
          <h2 id="rehearsal-panel-title">{label("rehearsalAdminTitle")}</h2>
          <p>{label("rehearsalAdminIntro")}</p>
        </div>
        {!confirmStart ? (
          <button type="button" onClick={() => setConfirmStart(true)}>
            {view ? label("rehearsalStartNew") : label("rehearsalStart")}
          </button>
        ) : (
          <div className={styles.rehearsalConfirm}>
            <p>{label("rehearsalStartConfirm")}</p>
            <button type="button" disabled={busy === "start"} onClick={() => void start()}>
              {busy === "start" ? label("rehearsalWorking") : label("rehearsalConfirm")}
            </button>
            <button type="button" onClick={() => setConfirmStart(false)}>{label("moderationCancel")}</button>
          </div>
        )}
      </div>
      <p className={styles.rehearsalLive} role="status" aria-live="polite">
        {loading ? label("rehearsalLoading") : error}
      </p>
      {view && (
        <>
          <div className={styles.rehearsalIdentity}>
            <div>
              <strong>{view.summary.status === "stale" ? label("rehearsalStale") : label("rehearsalStatus", { status: view.summary.status })}</strong>
              <bdi><code>{view.session.id}</code></bdi>
              <a href={rehearsalUrl}>{rehearsalUrl}</a>
            </div>
            {qr && <img src={qr} alt={label("rehearsalQrAlt")} />}
          </div>
          <ol className={styles.rehearsalRequirements}>
            {requirements.map((requirement) => (
              <li key={requirement} data-complete={view.summary.requirements[requirement].complete}>
                <span aria-hidden="true">{view.summary.requirements[requirement].complete ? "✓" : "○"}</span>
                {label(requirementKeys[requirement])}
              </li>
            ))}
          </ol>
          <fieldset className={styles.rehearsalManual}>
            <legend>{label("rehearsalManualTitle")}</legend>
            {manualChecks.map((check) => (
              <label key={check}>
                <input
                  type="checkbox"
                  checked={view.summary.manualChecks[check]}
                  disabled={view.summary.manualChecks[check] || Boolean(busy)}
                  onChange={() => void append({ kind: "manual-check", check })}
                />
                {label(manualKeys[check])}
              </label>
            ))}
          </fieldset>
          <div className={styles.rehearsalPhotos}>
            <h3>{label("rehearsalTrackedPhotos")}</h3>
            {view.summary.trackedPhotos.length === 0 ? <p>{label("rehearsalNoPhotos")}</p> : (
              <ul>
                {view.summary.trackedPhotos.map((photo) => (
                  <li key={photo.photoKey}>
                    <bdi><code>{photo.photoKey}</code></bdi>
                    <span>{photo.disposition}</span>
                    {photo.disposition === "pending" && (
                      <div>
                        <button type="button" disabled={Boolean(busy)} onClick={() => void observeDelivery(photo.photoKey)}>
                          {label("rehearsalObserveDelivery")}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={(event) => {
                            deleteTrigger.current = event.currentTarget;
                            setConfirmCanary(photo.photoKey);
                          }}
                        >
                          {label("rehearsalUseCanary")}
                        </button>
                        <button type="button" disabled={Boolean(busy)} onClick={() => void disposition(photo.photoKey, "retain")}>
                          {label("rehearsalRetain")}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={(event) => {
                            deleteTrigger.current = event.currentTarget;
                            setConfirmDelete(photo.photoKey);
                          }}
                        >
                          {label("rehearsalDeleteExact")}
                        </button>
                      </div>
                    )}
                    {confirmCanary === photo.photoKey && (
                      <div className={styles.rehearsalDeleteConfirm} role="alertdialog" aria-modal="true">
                        <strong>{label("rehearsalDeleteConfirm")}</strong>
                        <span>{photo.photoKey.slice(photo.photoKey.indexOf("/") + 1)}</span>
                        <bdi><code>{photo.photoKey}</code></bdi>
                        <button type="button" onClick={() => void deleteCanary(photo.photoKey)}>{label("rehearsalUseCanary")}</button>
                        <button type="button" onClick={() => setConfirmCanary(null)}>{label("moderationCancel")}</button>
                      </div>
                    )}
                    {confirmDelete === photo.photoKey && (
                      <div className={styles.rehearsalDeleteConfirm} role="alertdialog" aria-modal="true">
                        <strong>{label("rehearsalDeleteConfirm")}</strong>
                        <span>{photo.photoKey.slice(photo.photoKey.indexOf("/") + 1)}</span>
                        <bdi><code>{photo.photoKey}</code></bdi>
                        <button type="button" onClick={() => void disposition(photo.photoKey, "delete")}>{label("moderationConfirmDelete")}</button>
                        <button type="button" onClick={() => setConfirmDelete(null)}>{label("moderationCancel")}</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {view.summary.status === "active" || view.summary.status === "stale" ? (
            <button className={styles.rehearsalAbandon} type="button" disabled={Boolean(busy)} onClick={() => void append({ kind: "abandoned" })}>
              {label("rehearsalAbandon")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
