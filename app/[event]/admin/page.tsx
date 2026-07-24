"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { TEMPLATES } from "../../templates";
import type { ConfigRevision, PublicEventConfig } from "../../event-config";
import type { AdminBoothRecord, BoothOperationalState } from "../../booth-control";
import {
  BoothKeyControls,
  FrameProgrammeControls,
  SaveConfigurationButton,
} from "./admin-config-controls";
import {
  BoothOperationsCoordinator,
  boothOperationalStateInput,
  mergeBoothPages,
  parseAdminBoothPage,
  parseBoothOperationalStateResponse,
} from "./booth-operations";
import { BoothOperationsPanel } from "./booth-operations-panel";
import { ConfigHistoryPanel } from "./config-history-panel";
import {
  clearRestoreRequestAfterReconciliation,
  getOrCreateRestoreRequest,
  rebaseConfigHistory,
  shouldClearRestoreRequest,
  type ConfigHistoryResponse,
  type RestoreRequest,
} from "./config-mutation";
import styles from "./admin.module.css";

type Photo = { key: string; url: string; uploadedAt: string };
type AuthState = "missing" | "ready" | "invalid";
type Probe = { status: "up" | "degraded" | "down"; detail: string };
type Health = { upload: Probe; live: Probe };
type FilePickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }> };
const CONFIG_CONFLICT_MESSAGE = "Configuration changed; review the latest version before saving.";

export default function Admin() {
  const { event } = useParams<{ event: string }>();
  const [adminKey, setAdminKey] = useState("");
  const [auth, setAuth] = useState<AuthState>("missing");
  const [frames, setFrames] = useState<Set<string>>(new Set());
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState("");
  const [currentRevisionId, setCurrentRevisionId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ConfigRevision[]>([]);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);
  const [hasBoothKey, setHasBoothKey] = useState(false);
  const [boothKey, setBoothKey] = useState("");
  const [boothKeySaved, setBoothKeySaved] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [photosError, setPhotosError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");
  const [boothQr, setBoothQr] = useState("");
  const [liveQr, setLiveQr] = useState("");
  const [copied, setCopied] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [boothRecords, setBoothRecords] = useState<AdminBoothRecord[]>([]);
  const [boothCursor, setBoothCursor] = useState<string | null>(null);
  const [boothOperationalState, setBoothOperationalState] = useState<BoothOperationalState | null>(null);
  const [boothStatusLoading, setBoothStatusLoading] = useState(false);
  const [boothLoadingMore, setBoothLoadingMore] = useState(false);
  const [boothMutationBusy, setBoothMutationBusy] = useState(false);
  const [boothStatusError, setBoothStatusError] = useState(false);
  const [boothMessageDraft, setBoothMessageDraft] = useState("");
  const photoCursor = useRef<string | null>(null);
  const boothCoordinator = useRef(new BoothOperationsCoordinator());
  const boothMessageEditing = useRef(false);
  const configMutationBusy = useRef(false);
  const pendingSaveMutationId = useRef<string | null>(null);
  const pendingRestoreRequests = useRef(new Map<string, RestoreRequest>());

  const boothUrl = `${origin}/${event}`;
  const liveUrl = `${boothUrl}/live`;
  const defaults = useMemo(() => Object.keys(TEMPLATES).filter((key) => !TEMPLATES[key].group), []);
  const configBusy = saving || restoringRevisionId !== null;
  const clearPendingSave = () => {
    pendingSaveMutationId.current = null;
    setError((current) => current === CONFIG_CONFLICT_MESSAGE ? "" : current);
  };

  const invalidateAuth = () => {
    sessionStorage.removeItem("adminKey");
    setAuth("invalid");
  };

  const runHealth = useCallback(async (key = adminKey) => {
    setCheckingHealth(true); setError("");
    try {
      const response = await fetch("/api/health", { cache: "no-store", headers: { "x-booth-key": key } });
      if (response.status === 401) {
        sessionStorage.removeItem("adminKey");
        setAuth("invalid");
        throw new Error("That admin key was rejected.");
      }
      if (!response.ok) throw new Error(`Readiness checks failed (${response.status})`);
      setHealth(await response.json() as Health);
      setAuth("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Readiness checks could not run");
    } finally { setCheckingHealth(false); }
  }, [adminKey]);

  useEffect(() => {
    setOrigin(window.location.origin);
    const stored = sessionStorage.getItem("adminKey") || "";
    if (stored) {
      setAdminKey(stored);
      setAuth("ready");
    }
  }, []);

  useEffect(() => {
    if (!origin) return;
    void QRCode.toDataURL(boothUrl, { width: 240, margin: 1 }).then(setBoothQr).catch(() => setBoothQr(""));
    void QRCode.toDataURL(liveUrl, { width: 240, margin: 1 }).then(setLiveQr).catch(() => setLiveQr(""));
  }, [boothUrl, liveUrl, origin]);

  const loadConfig = useCallback(async () => {
    setConfigLoaded(false);
    setConfigError("");
    try {
      const response = await fetch(`/api/config/revisions?event=${encodeURIComponent(event)}`, {
        cache: "no-store",
        headers: { "x-booth-key": adminKey },
      });
      if (response.status === 401) {
        sessionStorage.removeItem("adminKey");
        setAuth("invalid");
        throw new Error("That admin key was rejected.");
      }
      if (!response.ok) throw new Error(`Configuration history returned ${response.status}`);
      const data = await response.json() as ConfigHistoryResponse;
      if (
        !data.config
        || !Array.isArray(data.revisions)
        || (data.currentRevisionId !== null && typeof data.currentRevisionId !== "string")
      ) {
        throw new Error("Configuration history had an unexpected shape");
      }
      const rebased = rebaseConfigHistory(data, defaults, pendingSaveMutationId);
      setFrames(new Set(rebased.frames));
      setHasBoothKey(rebased.hasBoothKey);
      setCurrentRevisionId(rebased.currentRevisionId);
      setRevisions(rebased.revisions);
      setConfigLoaded(true);
      return true;
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : "Config could not be loaded");
      return false;
    }
  }, [adminKey, defaults, event]);

  const loadPhotos = useCallback(async (reset = false) => {
    setPhotosError("");
    try {
      const query = new URLSearchParams({ event });
      if (!reset && photoCursor.current) query.set("after", photoCursor.current);
      const response = await fetch(`/api/photos?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Photo feed returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.photos)) throw new Error("Photo feed had an unexpected shape");
      setPhotos((current) => {
        if (reset || !photoCursor.current) return data.photos;
        const incoming = data.photos as Photo[];
        const keys = new Set(incoming.map((photo) => photo.key));
        return [...incoming, ...current.filter((photo) => !keys.has(photo.key))];
      });
      if (typeof data.cursor === "string" && data.cursor) photoCursor.current = data.cursor;
      setPhotosLoaded(true);
    } catch (cause) {
      setPhotosError(cause instanceof Error ? cause.message : "Photos could not be loaded");
    }
  }, [event]);

  const loadBoothStatus = useCallback(async () => {
    const coordinator = boothCoordinator.current;
    const ticket = coordinator.beginRead(event, adminKey);
    if (!ticket) return;
    setBoothStatusLoading(true);
    setBoothStatusError(false);
    try {
      const stateUrl = `/api/booth-state?event=${encodeURIComponent(event)}`;
      const devicesUrl = `/api/booths?event=${encodeURIComponent(event)}`;
      const headers = { "x-booth-key": adminKey };
      const [stateResult, devicesResult] = await Promise.allSettled([
        fetch(stateUrl, { cache: "no-store", headers, signal: ticket.signal }),
        fetch(devicesUrl, { cache: "no-store", headers, signal: ticket.signal }),
      ]);
      if (!coordinator.isReadCurrent(ticket)) return;

      let failed = false;
      if (stateResult.status === "rejected") {
        failed = true;
      } else if (stateResult.value.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      } else if (!stateResult.value.ok) {
        failed = true;
      } else {
        let nextState: BoothOperationalState | null = null;
        try {
          nextState = parseBoothOperationalStateResponse(await stateResult.value.json());
        } catch {
          // Invalid JSON is handled through the same fixed panel error.
        }
        if (!coordinator.isReadCurrent(ticket)) return;
        if (!nextState) {
          failed = true;
        } else {
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothOperationalState(nextState);
          if (!coordinator.isReadCurrent(ticket)) return;
          if (!boothMessageEditing.current) {
            setBoothMessageDraft(nextState.messages?.en ?? "");
          }
        }
      }

      if (devicesResult.status === "rejected") {
        failed = true;
      } else if (devicesResult.value.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      } else if (!devicesResult.value.ok) {
        failed = true;
      } else {
        let page = null;
        try {
          page = parseAdminBoothPage(await devicesResult.value.json());
        } catch {
          // Invalid JSON is handled through the same fixed panel error.
        }
        if (!coordinator.isReadCurrent(ticket)) return;
        if (!page) {
          failed = true;
        } else {
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothRecords((current) => mergeBoothPages(current, page.booths));
          const tailCursor = coordinator.acceptFirstPage(ticket, page.cursor);
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothCursor(tailCursor);
        }
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothStatusError(failed);
    } catch {
      if (coordinator.isReadCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishRead(ticket)) setBoothStatusLoading(false);
    }
  }, [adminKey, event]);

  const loadMoreBooths = useCallback(async () => {
    const coordinator = boothCoordinator.current;
    const cursor = coordinator.tailCursor();
    if (cursor === null) return;
    const ticket = coordinator.beginRead(event, adminKey);
    if (!ticket) return;
    setBoothLoadingMore(true);
    setBoothStatusError(false);
    try {
      const query = new URLSearchParams({ event, cursor });
      const response = await fetch(`/api/booths?${query}`, {
        cache: "no-store",
        headers: { "x-booth-key": adminKey },
        signal: ticket.signal,
      });
      if (!coordinator.isReadCurrent(ticket)) return;
      if (response.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      }
      if (!response.ok) {
        if (!coordinator.isReadCurrent(ticket)) return;
        setBoothStatusError(true);
        return;
      }
      let page = null;
      try {
        page = parseAdminBoothPage(await response.json());
      } catch {
        // Invalid JSON is handled through the same fixed panel error.
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      if (!page) {
        setBoothStatusError(true);
        return;
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothRecords((current) => mergeBoothPages(current, page.booths));
      const tailCursor = coordinator.advanceTail(ticket, page.cursor);
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothCursor(tailCursor);
    } catch {
      if (coordinator.isReadCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishRead(ticket)) setBoothLoadingMore(false);
    }
  }, [adminKey, event]);

  const updateBoothOperationalState = useCallback(async (paused: boolean) => {
    if (!boothOperationalState) return;
    const coordinator = boothCoordinator.current;
    const mutation = coordinator.beginMutation(event, adminKey);
    if (!mutation) return;
    const { ticket, abortedRead } = mutation;
    if (abortedRead) {
      setBoothStatusLoading(false);
      setBoothLoadingMore(false);
    }
    setBoothMutationBusy(true);
    setBoothStatusError(false);
    try {
      const response = await fetch(`/api/booth-state?event=${encodeURIComponent(event)}`, {
        method: "PUT",
        cache: "no-store",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        signal: ticket.signal,
        body: JSON.stringify(boothOperationalStateInput(
          boothOperationalState.messages,
          boothMessageDraft,
          paused
        )),
      });
      if (!coordinator.isMutationCurrent(ticket)) return;
      if (response.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      }
      if (!response.ok) {
        if (!coordinator.isMutationCurrent(ticket)) return;
        setBoothStatusError(true);
        return;
      }
      let nextState: BoothOperationalState | null = null;
      try {
        nextState = parseBoothOperationalStateResponse(await response.json());
      } catch {
        // Invalid JSON is handled through the same fixed panel error.
      }
      if (!coordinator.isMutationCurrent(ticket)) return;
      if (!nextState) {
        setBoothStatusError(true);
        return;
      }
      if (!coordinator.isMutationCurrent(ticket)) return;
      setBoothOperationalState(nextState);
      if (!coordinator.isMutationCurrent(ticket)) return;
      boothMessageEditing.current = false;
      if (!coordinator.isMutationCurrent(ticket)) return;
      setBoothMessageDraft(nextState.messages?.en ?? "");
    } catch {
      if (coordinator.isMutationCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishMutation(ticket)) setBoothMutationBusy(false);
    }
  }, [adminKey, boothMessageDraft, boothOperationalState, event]);

  useEffect(() => {
    photoCursor.current = null;
    void loadPhotos(true);
    const poll = window.setInterval(() => void loadPhotos(), 5000);
    return () => window.clearInterval(poll);
  }, [loadPhotos]);

  useEffect(() => {
    if (auth !== "ready" || !adminKey) return;
    void loadConfig();
  }, [adminKey, auth, loadConfig]);

  useEffect(() => {
    const coordinator = boothCoordinator.current;
    if (auth !== "ready" || !adminKey) {
      coordinator.disposeScope();
      return;
    }
    coordinator.activateScope(event, adminKey);
    boothMessageEditing.current = false;
    setBoothRecords([]);
    setBoothCursor(null);
    setBoothOperationalState(null);
    setBoothMessageDraft("");
    setBoothStatusLoading(false);
    setBoothLoadingMore(false);
    setBoothMutationBusy(false);
    setBoothStatusError(false);
    let cancelled = false;
    let nextPoll: number | undefined;
    const poll = async () => {
      await loadBoothStatus();
      if (!cancelled) nextPoll = window.setTimeout(() => void poll(), 15_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
      coordinator.disposeScope();
    };
  }, [adminKey, auth, event, loadBoothStatus]);

  const authenticate = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const next = adminKey.trim();
    if (!next) return;
    sessionStorage.setItem("adminKey", next);
    setAdminKey(next);
    setAuth("ready");
    setError("");
    void runHealth(next);
  };

  const toggle = (key: string) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setFrames((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setNotice("");
  };

  const setGroup = (group: string, enabled: boolean) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    const keys = Object.keys(TEMPLATES).filter((key) => TEMPLATES[key].group === group);
    setFrames((current) => {
      const next = new Set(current);
      keys.forEach((key) => enabled ? next.add(key) : next.delete(key));
      return next;
    });
  };

  const generateBoothKey = () => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    setBoothKey(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    setBoothKeySaved(false);
    setNotice("New key generated. Copy it now, then save the event.");
  };

  const changeBoothKey = (value: string) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setBoothKey(value);
    setBoothKeySaved(false);
  };

  const clearBoothKey = () => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setBoothKey("");
    setBoothKeySaved(false);
    setCopied("");
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? "" : current), 1800);
    } catch {
      setError("Clipboard access was blocked. Select and copy the value manually.");
    }
  };

  const save = async () => {
    if (!configLoaded || configMutationBusy.current) return;
    if (boothKey && boothKey.length < 12) {
      setError("Booth keys need at least 12 characters.");
      return;
    }
    configMutationBusy.current = true;
    setSaving(true); setError(""); setNotice("");
    const mutationId = pendingSaveMutationId.current ?? crypto.randomUUID();
    pendingSaveMutationId.current = mutationId;
    try {
      const response = await fetch(`/api/config?event=${encodeURIComponent(event)}`, {
        method: "PUT",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify({
          frames: [...frames],
          ...(boothKey ? { boothKey } : {}),
          mutationId,
          baseRevisionId: currentRevisionId,
        }),
      });
      if ([400, 401, 409].includes(response.status)) pendingSaveMutationId.current = null;
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (response.status === 409) {
        await loadConfig();
        setError(CONFIG_CONFLICT_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = await response.json() as PublicEventConfig & { currentRevisionId: string };
      pendingSaveMutationId.current = null;
      setCurrentRevisionId(data.currentRevisionId);
      if (boothKey) { setHasBoothKey(true); setBoothKeySaved(true); }
      await loadConfig();
      setNotice(boothKey ? "Event saved. Keep the new booth key somewhere secure." : "Event configuration saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Event could not be saved");
    } finally {
      configMutationBusy.current = false;
      setSaving(false);
    }
  };

  const restoreRevision = async (revisionId: string) => {
    if (!configLoaded || configMutationBusy.current) return;
    configMutationBusy.current = true;
    const pending = pendingRestoreRequests.current;
    const request = getOrCreateRestoreRequest(
      pending,
      revisionId,
      currentRevisionId,
      () => crypto.randomUUID()
    );
    setRestoringRevisionId(revisionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/config/revisions/restore?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (shouldClearRestoreRequest(response.status)) pending.delete(revisionId);
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (response.status === 409) {
        await loadConfig();
        setError(CONFIG_CONFLICT_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(`Restore failed (${response.status})`);
      await clearRestoreRequestAfterReconciliation(pending, request, async () => {
        const data = await response.json() as PublicEventConfig & { currentRevisionId: string };
        setFrames(new Set(Array.isArray(data.frames) ? data.frames : defaults));
        setHasBoothKey(Boolean(data.hasBoothKey));
        setCurrentRevisionId(data.currentRevisionId);
        setBoothKey("");
        setBoothKeySaved(false);
        setCopied((current) => current === "key" ? "" : current);
        if (!await loadConfig()) {
          throw new Error("Configuration restored, but history could not be reloaded.");
        }
      });
      setNotice("Configuration restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration could not be restored");
    } finally {
      configMutationBusy.current = false;
      setRestoringRevisionId(null);
    }
  };

  const exportZip = async () => {
    setExporting(true); setError("");
    try {
      // Ask for the destination while the click's user activation is still
      // live. The response can then stream straight to disk without a giant blob.
      const picker = (window as FilePickerWindow).showSaveFilePicker;
      const handle = picker ? await picker({ suggestedName: `${event}-photos.zip`, types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }] }) : null;
      const response = await fetch(`/api/export?event=${encodeURIComponent(event)}`, { headers: { "x-booth-key": adminKey } });
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      if (handle && response.body) {
        const writable = await handle.createWritable();
        await response.body.pipeTo(writable);
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `${event}-photos.zip`; anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Export could not be created");
    } finally { setExporting(false); }
  };

  const deletePhoto = async (photo: Photo) => {
    setDeleting(photo.key); setError("");
    try {
      const response = await fetch(`/api/photos?event=${encodeURIComponent(event)}&key=${encodeURIComponent(photo.key)}`, {
        method: "DELETE", headers: { "x-booth-key": adminKey },
      });
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      setPhotos((current) => current.filter((item) => item.key !== photo.key));
      setConfirmDelete("");
      setNotice("Photo removed from the event.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Photo could not be deleted");
    } finally { setDeleting(""); }
  };

  const facts: { label: string; value: string; tone: "good" | "bad" | "wait"; detail?: string }[] = [
    { label: "Config", value: configLoaded ? "Loaded" : configError ? "Error" : "Checking", tone: configLoaded ? "good" : configError ? "bad" : "wait" },
    { label: "Frames", value: `${frames.size} enabled`, tone: frames.size > 0 ? "good" : "bad" },
    { label: "Booth key", value: hasBoothKey ? "Installed" : "Missing", tone: hasBoothKey ? "good" : "bad" },
    { label: "Photos", value: photosLoaded ? `${photos.length} live` : photosError ? "Error" : "Checking", tone: photosLoaded ? "good" : photosError ? "bad" : "wait" },
    { label: "Upload", value: health ? health.upload.status : "Unchecked", tone: health ? health.upload.status === "up" ? "good" : health.upload.status === "degraded" ? "wait" : "bad" : "wait", detail: health?.upload.detail },
    { label: "Live", value: health ? health.live.status : "Unchecked", tone: health ? health.live.status === "up" ? "good" : health.live.status === "degraded" ? "wait" : "bad" : "wait", detail: health?.live.detail },
  ];

  if (auth !== "ready") {
    return (
      <main className={styles.authPage}>
        <form className={styles.authCard} onSubmit={authenticate}>
          <p className={styles.kicker}>Darkroom access / {event}</p>
          <h1>Operator<br />sign-in</h1>
          <p>{auth === "invalid" ? "That credential was rejected. Enter the admin key again." : "Load the admin credential to operate this event."}</p>
          <label htmlFor="admin-key">Admin key</label>
          <input id="admin-key" type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="current-password" autoFocus />
          <button type="submit" disabled={!adminKey.trim()}>Enter darkroom →</button>
        </form>
      </main>
    );
  }

  return (
    <main className={styles.console}>
      <header className={styles.header}>
        <div><p className={styles.kicker}>Webbooth / operator console</p><h1>{event}</h1><code>/{event}</code></div>
        <div className={styles.headerActions}>
          <a href="/frame-lab">Open frame lab ↗</a>
          <button onClick={() => { sessionStorage.removeItem("adminKey"); setAuth("missing"); setAdminKey(""); }}>Lock console</button>
        </div>
      </header>

      <section className={styles.readiness} aria-label="Event readiness">
        <div className={styles.railLabel}><span>Ready?</span><strong>{facts.every((fact) => fact.tone === "good") ? "YES" : "CHECK"}</strong><button onClick={() => void runHealth()} disabled={checkingHealth}>{checkingHealth ? "Running…" : "Run checks"}</button></div>
        {facts.map((fact, index) => <div className={styles.fact} key={fact.label} title={fact.detail}><span>0{index + 1} / {fact.label}</span><strong data-tone={fact.tone}>{fact.value}</strong></div>)}
      </section>

      {(error || notice) && <div className={error ? styles.errorBanner : styles.noticeBanner} role="status"><span>{error ? "Attention" : "Done"}</span><p>{error || notice}</p><button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.section}>
            <div className={styles.sectionHead}><div><span>01</span><h2>Frame programme</h2></div><p>Choose what guests see at the booth. Previews follow the real background → photo → overlay composition.</p></div>
            {configError ? <div className={styles.failure}><strong>Config unavailable</strong><p>{configError}</p><button onClick={() => void loadConfig()}>Retry config</button></div> :
            <FrameProgrammeControls
              frames={frames}
              defaults={defaults}
              disabled={configBusy}
              onToggle={toggle}
              onSetGroup={setGroup}
            />}
          </section>

          <ConfigHistoryPanel
            currentFrames={[...frames]}
            currentRevisionId={currentRevisionId}
            revisions={revisions}
            loading={!configLoaded && !configError}
            restoringRevisionId={restoringRevisionId}
            mutationBusy={configBusy}
            error={configError}
            onReload={() => void loadConfig()}
            onRestore={(revisionId) => void restoreRevision(revisionId)}
          />

          <BoothOperationsPanel
            records={boothRecords}
            cursor={boothCursor}
            operationalState={boothOperationalState}
            loading={boothStatusLoading}
            loadingMore={boothLoadingMore}
            mutationBusy={boothMutationBusy}
            hasError={boothStatusError}
            englishMessageDraft={boothMessageDraft}
            onEnglishMessageChange={(message) => {
              boothMessageEditing.current = true;
              setBoothMessageDraft(message);
            }}
            onRefresh={() => void loadBoothStatus()}
            onLoadMore={() => void loadMoreBooths()}
            onPause={() => void updateBoothOperationalState(true)}
            onResume={() => void updateBoothOperationalState(false)}
          />

          <section className={styles.section}>
            <div className={styles.sectionHead}><div><span>04</span><h2>Recent contact sheet</h2></div><p>{photos.length} photograph{photos.length === 1 ? "" : "s"} currently in this event.</p></div>
            {photosError && photos.length === 0 ? <div className={styles.failure}><strong>Photo feed unavailable</strong><p>{photosError}</p><button onClick={() => void loadPhotos(true)}>Retry photos</button></div> : photosLoaded && photos.length === 0 ?
              <div className={styles.emptySheet}><strong>No exposures yet.</strong><p>Open the booth link and take a test photo before doors open.</p></div> :
              <div className={styles.contactSheet}>{photos.slice(0, 16).map((photo) => <article key={photo.key} className={styles.contactPhoto}>
                <img src={photo.url} alt={`Event photograph uploaded ${new Date(photo.uploadedAt).toLocaleString()}`} />
                <div><time>{new Date(photo.uploadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><code title={photo.key}>{photo.key.split("/").pop()}</code></div>
                {confirmDelete === photo.key ? <div className={styles.deleteConfirm}><span>Delete exactly this photo?</span><button onClick={() => void deletePhoto(photo)} disabled={deleting === photo.key}>{deleting === photo.key ? "Removing…" : "Yes, remove"}</button><button onClick={() => setConfirmDelete("")}>Keep</button></div> : <button className={styles.removePhoto} onClick={() => setConfirmDelete(photo.key)}>Remove</button>}
              </article>)}</div>}
          </section>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.sideCard}>
            <span className={styles.cardNumber}>05</span><h2>Booth credential</h2>
            <p>{hasBoothKey ? "A booth key is installed. Generate a replacement only when rotating iPad access." : "No booth key yet. Generate one before the booth can upload."}</p>
            <BoothKeyControls
              value={boothKey}
              saved={boothKeySaved}
              copied={copied === "key"}
              disabled={configBusy}
              placeholder={hasBoothKey ? "Unchanged" : "Generate a key"}
              onChange={changeBoothKey}
              onGenerate={generateBoothKey}
              onCopy={() => void copy(boothKey, "key")}
              onClear={clearBoothKey}
            />
          </section>

          <LinkCard label="Booth / iPad" url={boothUrl} qr={boothQr} copied={copied === "booth"} copy={() => void copy(boothUrl, "booth")} />
          <LinkCard label="Live / projector" url={liveUrl} qr={liveQr} copied={copied === "live"} copy={() => void copy(liveUrl, "live")} />

          <section className={styles.sideCard}>
            <span className={styles.cardNumber}>06</span><h2>Ship the event</h2>
            <SaveConfigurationButton
              disabled={!configLoaded || configBusy}
              saving={saving}
              onSave={() => void save()}
            />
            <button className={styles.exportButton} onClick={() => void exportZip()} disabled={exporting}>{exporting ? "Building archive…" : `Export ${photos.length} photos (.zip)`}</button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function LinkCard({ label, url, qr, copied, copy }: { label: string; url: string; qr: string; copied: boolean; copy: () => void }) {
  return <section className={styles.linkCard}>
    <div><span>Event route</span><h2>{label}</h2><code>{url || "Building URL…"}</code><div className={styles.linkActions}><a href={url}>Open ↗</a><button onClick={copy}>{copied ? "Copied ✓" : "Copy URL"}</button></div></div>
    {qr && <img src={qr} alt={`QR code for ${label}`} />}
  </section>;
}
