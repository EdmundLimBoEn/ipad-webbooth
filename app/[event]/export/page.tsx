"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";

export default function Export() {
  const { event } = useParams<{ event: string }>();
  const [status, setStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [error, setError] = useState("");

  const download = useCallback(async () => {
    setStatus("downloading");
    setError("");
    try {
      let key = localStorage.getItem("boothKey");
      if (!key) {
        key = window.prompt("Enter booth upload key") ?? "";
        if (key) localStorage.setItem("boothKey", key);
      }
      const res = await fetch(`/api/export?event=${encodeURIComponent(event)}`, {
        headers: { "x-booth-key": key ?? "" },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "Wrong upload key" : `Export failed (${res.status})`);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = `${event}-photos.zip`;
      a.click();
      URL.revokeObjectURL(obj);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [event]);

  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100dvh", gap: 16, color: "#fff", background: "#111" }}>
      <h1>Export photos — {event}</h1>
      <button
        onClick={download}
        disabled={status === "downloading"}
        style={{ padding: "12px 24px", fontSize: 18, borderRadius: 8, border: "none", cursor: "pointer" }}
      >
        {status === "downloading" ? "Zipping…" : "Download all photos (.zip)"}
      </button>
      {error && <p style={{ color: "salmon" }}>{error}</p>}
    </main>
  );
}
