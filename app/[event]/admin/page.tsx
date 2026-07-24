"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { GROUPS, TEMPLATES } from "../../templates";
import type { ConfigRevision, PublicEventConfig } from "../../event-config";
import type { Template } from "../../frame-packs/types";
import { ConfigHistoryPanel } from "./config-history-panel";
import styles from "./admin.module.css";

type Photo = { key: string; url: string; uploadedAt: string };
type AuthState = "missing" | "ready" | "invalid";
type Probe = { status: "up" | "degraded" | "down"; detail: string };
type Health = { upload: Probe; live: Probe };
type ConfigHistoryResponse = {
  config: PublicEventConfig;
  currentRevisionId: string | null;
  revisions: ConfigRevision[];
};
type FilePickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }> };
const CONFIG_CONFLICT_MESSAGE = "Configuration changed; review the latest version before saving.";

function FramePreview({ frame }: { frame: Template }) {
  return (
    <span className={styles.framePreview} style={{ aspectRatio: `${frame.canvas.w}/${frame.canvas.h}`, backgroundColor: frame.background || "#d8d5cc" }}>
      {frame.bgImage && <img src={frame.bgImage} alt="" className={styles.frameLayer} />}
      {frame.slots.map((slot, index) => (
        <span
          key={index}
          className={styles.photoSlot}
          style={{
            left: `${slot.x / frame.canvas.w * 100}%`,
            top: `${slot.y / frame.canvas.h * 100}%`,
            width: `${slot.w / frame.canvas.w * 100}%`,
            height: `${slot.h / frame.canvas.h * 100}%`,
          }}
        />
      ))}
      {frame.overlay && <img src={frame.overlay} alt="" className={styles.overlayLayer} />}
    </span>
  );
}

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
  const photoCursor = useRef<string | null>(null);
  const pendingSaveMutationId = useRef<string | null>(null);
  const pendingRestoreMutationIds = useRef(new Map<string, string>());

  const boothUrl = `${origin}/${event}`;
  const liveUrl = `${boothUrl}/live`;
  const defaults = useMemo(() => Object.keys(TEMPLATES).filter((key) => !TEMPLATES[key].group), []);
  const clearPendingSave = () => {
    pendingSaveMutationId.current = null;
    setError((current) => current === CONFIG_CONFLICT_MESSAGE ? "" : current);
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
      setFrames(new Set(Array.isArray(data.config.frames) ? data.config.frames : defaults));
      setHasBoothKey(Boolean(data.config.hasBoothKey));
      setCurrentRevisionId(data.currentRevisionId);
      setRevisions(data.revisions);
      setConfigLoaded(true);
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : "Config could not be loaded");
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

  const invalidateAuth = () => {
    sessionStorage.removeItem("adminKey");
    setAuth("invalid");
  };

  const toggle = (key: string) => {
    clearPendingSave();
    setFrames((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setNotice("");
  };

  const setGroup = (group: string, enabled: boolean) => {
    clearPendingSave();
    const keys = Object.keys(TEMPLATES).filter((key) => TEMPLATES[key].group === group);
    setFrames((current) => {
      const next = new Set(current);
      keys.forEach((key) => enabled ? next.add(key) : next.delete(key));
      return next;
    });
  };

  const generateBoothKey = () => {
    clearPendingSave();
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    setBoothKey(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    setBoothKeySaved(false);
    setNotice("New key generated. Copy it now, then save the event.");
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
    if (!configLoaded) return;
    if (boothKey && boothKey.length < 12) {
      setError("Booth keys need at least 12 characters.");
      return;
    }
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
    } finally { setSaving(false); }
  };

  const restoreRevision = async (revisionId: string) => {
    if (!configLoaded) return;
    const pending = pendingRestoreMutationIds.current;
    const mutationId = pending.get(revisionId) ?? crypto.randomUUID();
    pending.set(revisionId, mutationId);
    setRestoringRevisionId(revisionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/config/revisions/restore?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify({
          revisionId,
          mutationId,
          baseRevisionId: currentRevisionId,
        }),
      });
      if ([400, 401, 404, 409].includes(response.status)) pending.delete(revisionId);
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (response.status === 409) {
        await loadConfig();
        setError(CONFIG_CONFLICT_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(`Restore failed (${response.status})`);
      const data = await response.json() as PublicEventConfig & { currentRevisionId: string };
      pending.delete(revisionId);
      pendingSaveMutationId.current = null;
      setFrames(new Set(Array.isArray(data.frames) ? data.frames : defaults));
      setHasBoothKey(Boolean(data.hasBoothKey));
      setCurrentRevisionId(data.currentRevisionId);
      setBoothKey("");
      setBoothKeySaved(false);
      setCopied((current) => current === "key" ? "" : current);
      await loadConfig();
      setNotice("Configuration restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration could not be restored");
    } finally {
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
            <div className={styles.frameGroups}>
              <div className={styles.frameGroup}>
                <div className={styles.groupHead}><h3>House frames</h3></div>
                <div className={styles.filmRail}>{defaults.map((key) => <FrameCard key={key} frameKey={key} enabled={frames.has(key)} toggle={toggle} />)}</div>
              </div>
              {Object.entries(GROUPS).map(([group, label]) => {
                const keys = Object.keys(TEMPLATES).filter((key) => TEMPLATES[key].group === group);
                const allOn = keys.every((key) => frames.has(key));
                return <div className={styles.frameGroup} key={group}>
                  <div className={styles.groupHead}><h3>{label}</h3><button onClick={() => setGroup(group, !allOn)}>{allOn ? "Disable pack" : "Enable pack"}</button></div>
                  <div className={styles.filmRail}>{keys.map((key) => <FrameCard key={key} frameKey={key} enabled={frames.has(key)} toggle={toggle} />)}</div>
                </div>;
              })}
            </div>}
          </section>

          <ConfigHistoryPanel
            currentFrames={[...frames]}
            currentRevisionId={currentRevisionId}
            revisions={revisions}
            loading={!configLoaded && !configError}
            restoringRevisionId={restoringRevisionId}
            error={configError}
            onReload={() => void loadConfig()}
            onRestore={(revisionId) => void restoreRevision(revisionId)}
          />

          <section className={styles.section}>
            <div className={styles.sectionHead}><div><span>03</span><h2>Recent contact sheet</h2></div><p>{photos.length} photograph{photos.length === 1 ? "" : "s"} currently in this event.</p></div>
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
            <span className={styles.cardNumber}>04</span><h2>Booth credential</h2>
            <p>{hasBoothKey ? "A booth key is installed. Generate a replacement only when rotating iPad access." : "No booth key yet. Generate one before the booth can upload."}</p>
            <div className={styles.keyRow}><input aria-label="New booth key" value={boothKey} onChange={(e) => { clearPendingSave(); setBoothKey(e.target.value.trim()); setBoothKeySaved(false); }} placeholder={hasBoothKey ? "Unchanged" : "Generate a key"} autoComplete="off" /><button onClick={generateBoothKey}>Generate</button></div>
            {boothKey && <button className={styles.copyWide} onClick={() => void copy(boothKey, "key")}>{copied === "key" ? "Copied ✓" : "Copy generated key"}</button>}
            {boothKey && boothKeySaved && <button className={styles.clearKey} onClick={() => { clearPendingSave(); setBoothKey(""); setBoothKeySaved(false); setCopied(""); }}>Stored safely — clear key</button>}
          </section>

          <LinkCard label="Booth / iPad" url={boothUrl} qr={boothQr} copied={copied === "booth"} copy={() => void copy(boothUrl, "booth")} />
          <LinkCard label="Live / projector" url={liveUrl} qr={liveQr} copied={copied === "live"} copy={() => void copy(liveUrl, "live")} />

          <section className={styles.sideCard}>
            <span className={styles.cardNumber}>06</span><h2>Ship the event</h2>
            <button className={styles.saveButton} onClick={() => void save()} disabled={!configLoaded || saving}>{saving ? "Saving event…" : "Save configuration"}</button>
            <button className={styles.exportButton} onClick={() => void exportZip()} disabled={exporting}>{exporting ? "Building archive…" : `Export ${photos.length} photos (.zip)`}</button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function FrameCard({ frameKey, enabled, toggle }: { frameKey: string; enabled: boolean; toggle: (key: string) => void }) {
  const frame = TEMPLATES[frameKey];
  return <label className={styles.frameCard} data-enabled={enabled}>
    <input type="checkbox" checked={enabled} onChange={() => toggle(frameKey)} />
    <FramePreview frame={frame} />
    <span className={styles.frameMeta}><strong>{frame.label}</strong><small>{frame.shots} shot{frame.shots === 1 ? "" : "s"} / {frame.canvas.w}×{frame.canvas.h}</small></span>
    <span className={styles.frameCheck}>{enabled ? "ON" : "OFF"}</span>
  </label>;
}

function LinkCard({ label, url, qr, copied, copy }: { label: string; url: string; qr: string; copied: boolean; copy: () => void }) {
  return <section className={styles.linkCard}>
    <div><span>Event route</span><h2>{label}</h2><code>{url || "Building URL…"}</code><div className={styles.linkActions}><a href={url}>Open ↗</a><button onClick={copy}>{copied ? "Copied ✓" : "Copy URL"}</button></div></div>
    {qr && <img src={qr} alt={`QR code for ${label}`} />}
  </section>;
}
