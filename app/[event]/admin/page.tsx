"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { TEMPLATES, GROUPS } from "../../templates";

// One-stop event admin (Edmund only — gated by the admin key, a Worker
// secret): per-event frame allowlist, per-event booth key, photo export.
export default function Admin() {
  const { event } = useParams<{ event: string }>();
  const [frames, setFrames] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  // the per-event booth key: write-only (the server stores a hash), so this
  // field is what will be SET on save; empty = keep the current one
  const [boothKey, setBoothKey] = useState("");
  const [hasBoothKey, setHasBoothKey] = useState(false);

  const getKey = () => {
    let key = localStorage.getItem("adminKey");
    if (!key) {
      key = window.prompt("Enter admin key") ?? "";
      if (key) localStorage.setItem("adminKey", key);
    }
    return key ?? "";
  };

  const load = useCallback(() => {
    setLoadError(false);
    fetch(`/api/config?event=${encodeURIComponent(event)}`)
      .then((r) => r.json())
      .then((d) => {
        // no config yet -> the ungrouped defaults start ticked (on by default)
        const defaults = Object.keys(TEMPLATES).filter((k) => !TEMPLATES[k].group);
        setFrames(new Set(Array.isArray(d.frames) ? d.frames : defaults));
        setHasBoothKey(!!d.hasBoothKey);
        setLoaded(true);
      })
      .catch(() => setLoadError(true));
  }, [event]);
  useEffect(load, [load]);

  const toggle = (k: string) => {
    setFrames((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setMsg("");
  };

  const setGroup = (gid: string, on: boolean) => {
    const keys = Object.keys(TEMPLATES).filter((k) => TEMPLATES[k].group === gid);
    setFrames((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
      return next;
    });
    setMsg("");
  };

  const generateBoothKey = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    setBoothKey(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
    setMsg("");
  };

  const save = useCallback(async () => {
    if (boothKey && boothKey.length < 12) {
      setError("Booth key must be at least 12 characters — use Generate");
      return;
    }
    setSaving(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch(`/api/config?event=${encodeURIComponent(event)}`, {
        method: "PUT",
        headers: { "x-booth-key": getKey(), "content-type": "application/json" },
        body: JSON.stringify({ frames: [...frames], ...(boothKey ? { boothKey } : {}) }),
      });
      if (res.status === 401) {
        localStorage.removeItem("adminKey"); // wrong key: re-prompt next try
        throw new Error("Wrong admin key");
      }
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      if (boothKey) {
        setHasBoothKey(true);
        setMsg("Saved ✓ — record the booth key in EDMUNDS-STUFF.md, it can't be shown again");
      } else {
        setMsg("Saved ✓");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [event, frames, boothKey]);

  const exportZip = useCallback(async () => {
    setExporting(true);
    setError("");
    try {
      const res = await fetch(`/api/export?event=${encodeURIComponent(event)}`, {
        headers: { "x-booth-key": getKey() },
      });
      if (res.status === 401) {
        localStorage.removeItem("adminKey");
        throw new Error("Wrong admin key");
      }
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = `${event}-photos.zip`;
      a.click();
      URL.revokeObjectURL(obj);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [event]);

  const defaults = Object.keys(TEMPLATES).filter((k) => !TEMPLATES[k].group);
  const section: React.CSSProperties = { width: "min(680px, 92vw)", display: "flex", flexDirection: "column", gap: 12 };
  const card: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
    borderRadius: 12, background: "rgba(255,255,255,0.08)", cursor: "pointer",
  };
  const thumb: React.CSSProperties = { height: 48, width: "auto", borderRadius: 6 };
  const btn: React.CSSProperties = {
    padding: "12px 24px", fontSize: 16, fontWeight: 600, borderRadius: 8, border: "none",
    cursor: "pointer", background: "#ff2d8b", color: "#fff",
  };
  const input: React.CSSProperties = {
    flex: 1, padding: "10px 12px", fontSize: 15, borderRadius: 8, border: "none",
    background: "rgba(255,255,255,0.12)", color: "#fff", fontFamily: "ui-monospace, monospace",
  };

  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 0 80px", minHeight: "100dvh", gap: 28, color: "#fff", background: "#111", fontFamily: "system-ui" }}>
      <h1>Admin — {event}</h1>

      {loadError && (
        <section style={section}>
          <p style={{ color: "salmon" }}>Failed to load config.</p>
          <button onClick={load} style={btn}>Retry</button>
        </section>
      )}

      <section style={section}>
        <h2 style={{ fontSize: 18 }}>Frames</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>
          Tick the frames this event may use, then save. Default frames start on.
        </p>

        {defaults.map((k) => (
          <label key={k} style={card}>
            <input type="checkbox" checked={frames.has(k)} onChange={() => toggle(k)} style={{ width: 20, height: 20 }} />
            <span style={{ ...thumb, width: 48, background: TEMPLATES[k].background ?? "#ff2d8b" }} />
            <span style={{ flex: 1 }}>{TEMPLATES[k].label}</span>
            <span style={{ fontSize: 13, opacity: 0.7 }}>default</span>
          </label>
        ))}

        {Object.entries(GROUPS).map(([gid, glabel]) => {
          const keys = Object.keys(TEMPLATES).filter((k) => TEMPLATES[k].group === gid);
          const allOn = keys.every((k) => frames.has(k));
          return (
            <div key={gid} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <h3 style={{ fontSize: 16 }}>{glabel}</h3>
                <button
                  onClick={() => setGroup(gid, !allOn)}
                  style={{ background: "none", border: "none", color: "#ffb3d9", cursor: "pointer", fontSize: 13 }}
                >
                  {allOn ? "disable all" : "enable all"}
                </button>
              </div>
              {keys.map((k) => (
                <label key={k} style={card}>
                  <input type="checkbox" checked={frames.has(k)} onChange={() => toggle(k)} style={{ width: 20, height: 20 }} />
                  {TEMPLATES[k].bgImage && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={TEMPLATES[k].bgImage} alt="" style={thumb} />
                  )}
                  <span style={{ flex: 1 }}>{TEMPLATES[k].label}</span>
                  <span style={{ fontSize: 13, opacity: 0.7 }}>{TEMPLATES[k].shots === 1 ? "1 photo" : `${TEMPLATES[k].shots} photos`}</span>
                </label>
              ))}
            </div>
          );
        })}
      </section>

      <section style={section}>
        <h2 style={{ fontSize: 18 }}>Booth key</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>
          The key the booth page asks for. Per event — it can only upload photos to this
          event, so it&apos;s safe to type into the guest-facing iPad.{" "}
          {hasBoothKey
            ? "This event has a booth key. Fill the field to replace it; leave empty to keep it."
            : "No booth key set yet — only the admin key can upload. Generate one and save."}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={boothKey}
            onChange={(e) => { setBoothKey(e.target.value.trim()); setMsg(""); }}
            placeholder={hasBoothKey ? "(unchanged)" : "(none set)"}
            style={input}
            autoComplete="off"
          />
          <button onClick={generateBoothKey} style={btn}>Generate</button>
        </div>
        <p style={{ opacity: 0.7, fontSize: 13 }}>
          The server stores only a hash — record the key in EDMUNDS-STUFF.md before leaving this page.
        </p>
      </section>

      <section style={section}>
        <button onClick={save} disabled={!loaded || saving} style={btn}>
          {saving ? "Saving…" : "Save frames + booth key"}
        </button>
        {msg && <p style={{ color: "#8f8" }}>{msg}</p>}
      </section>

      <section style={section}>
        <h2 style={{ fontSize: 18 }}>Export</h2>
        <button onClick={exportZip} disabled={exporting} style={btn}>
          {exporting ? "Zipping…" : "Download all photos (.zip)"}
        </button>
      </section>

      {error && <p style={{ color: "salmon" }}>{error}</p>}
    </main>
  );
}
