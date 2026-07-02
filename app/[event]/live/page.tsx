"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./live.module.css";

type Photo = { url: string; uploadedAt: string };

export default function Live() {
  const { event } = useParams<{ event: string }>();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [full, setFull] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // duplicate the grid (for the seamless loop) only once one copy is taller
  // than the screen — i.e. the board is full enough that scrolling is needed.
  const [dup, setDup] = useState(false);

  const copyARef = useRef<HTMLDivElement>(null);
  const copyBRef = useRef<HTMLDivElement>(null);
  const periodRef = useRef(0); // px between the two identical copies = loop length

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/photos?event=${encodeURIComponent(event)}`, { cache: "no-store" });
        const { photos } = await res.json();
        if (alive) setPhotos(photos);
      } catch {
        /* keep last good state; try again next tick */
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [event]);

  // After each render, decide whether we can loop and measure the loop length.
  // The period is the distance from copy A's top to copy B's top, so the reset
  // by exactly that amount lands on pixel-identical content (invisible seam).
  useLayoutEffect(() => {
    const measure = () => {
      const a = copyARef.current;
      if (!a) return;
      setDup(a.offsetHeight > window.innerHeight);
      if (a && copyBRef.current) {
        periodRef.current = copyBRef.current.offsetTop - a.offsetTop;
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [photos, dup]);

  // Projector marquee: creep the page down forever with a seamless wrap. When
  // we've scrolled one full copy, snap back by exactly that copy's height —
  // identical pixels, so there's no visible jump. Pauses while a photo is open
  // and for a few seconds after any manual scroll/tap, so phone viewers can
  // browse and download without the page fighting them.
  useEffect(() => {
    if (!dup) return;
    let raf = 0;
    let last: number | null = null;
    let pos = window.scrollY;
    let idleUntil = 0;
    const SPEED = 40; // px/sec
    const bump = () => {
      idleUntil = performance.now() + 4000;
      pos = window.scrollY;
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const step = (t: number) => {
      const period = periodRef.current;
      const active = last !== null && !full && t > idleUntil && period > 4;
      if (active) {
        pos += SPEED * Math.min((t - last!) / 1000, 0.1);
        if (pos >= period) pos -= period; // seamless wrap onto the identical copy
        window.scrollTo(0, pos);
      } else {
        pos = window.scrollY; // stay in sync while paused / interacting
      }
      last = t;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [dup, full]);

  // Save to device. Fetch → object URL so it works cross-origin. On mobile,
  // prefer the native share sheet (Save to Photos on iOS); fall back to a
  // download link on desktop.
  const save = useCallback(async (url: string) => {
    setSaving(true);
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `photobooth-${Date.now()}.jpg`, { type: "image/jpeg" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const obj = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = obj;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(obj);
      }
    } catch {
      /* user cancelled share, or blocked — ignore */
    } finally {
      setSaving(false);
    }
  }, []);

  const grid = (keyPrefix: string) => (
    <div className={styles.grid}>
      {photos.map((p) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={keyPrefix + p.url}
          src={p.url}
          alt=""
          loading="lazy"
          className={styles.tile}
          onClick={() => setFull(p.url)}
        />
      ))}
    </div>
  );

  return (
    <main className={styles.live}>
      {photos.length === 0 && <p className={styles.empty}>Waiting for the first photo…</p>}

      <div ref={copyARef}>{grid("a-")}</div>
      {dup && (
        <div ref={copyBRef} aria-hidden>
          {grid("b-")}
        </div>
      )}

      {full && (
        <div className={styles.lightbox} onClick={() => setFull(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={full} alt="" className={styles.fullImg} onClick={(e) => e.stopPropagation()} />
          <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
            <button className={styles.save} onClick={() => save(full)} disabled={saving}>
              {saving ? "Saving…" : "⬇ Save photo"}
            </button>
            <button className={styles.close} onClick={() => setFull(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
