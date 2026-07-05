"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./live.module.css";
import { wrap } from "./wrap";

type Photo = { url: string; uploadedAt: string };

const SPEED = 40; // px/sec
const GAP = 12; // must match the CSS gap/padding-bottom on .copy
const PAD = 14;

export default function Live() {
  const { event } = useParams<{ event: string }>();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [full, setFull] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // measured height/width per photo url, so columns can be balanced by real height
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);
  const [pageUrl, setPageUrl] = useState("");

  useEffect(() => {
    setPageUrl(window.location.href);
  }, []);

  // per-column marquee state: each column loops independently so there are
  // never black gaps — a column's photos repeat seamlessly at its own period.
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const periodsRef = useRef<number[]>([]);
  const posRef = useRef<number[]>([]);
  const fullRef = useRef(false);
  // cumulative pointer travel of the last drag; >10px suppresses the tile click
  const dragDistRef = useRef(0);
  useEffect(() => {
    fullRef.current = !!full;
  }, [full]);

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

  useEffect(() => {
    const calc = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  const cols = vw >= 1500 ? 5 : vw >= 1000 ? 4 : vw >= 640 ? 3 : 2;
  const colW = Math.max(0, (vw - PAD * 2 - GAP * (cols - 1)) / cols);

  // Balanced masonry: drop each photo into the shortest column so far (by
  // measured aspect ratio, since all columns share one width), so columns
  // end at nearly the same height.
  const columns: Photo[][] = Array.from({ length: cols }, () => []);
  const heights = new Array<number>(cols).fill(0); // px incl. trailing gap
  for (const p of photos) {
    const i = heights.indexOf(Math.min(...heights));
    columns[i].push(p);
    heights[i] += (ratios[p.url] ?? 1) * colW + GAP; // assume square until measured
  }
  const animate = vh > 0 && Math.max(0, ...heights) > vh;

  // Measure each column's loop period (one copy's height, incl. its trailing
  // padding) after every render, so the wrap always lands on identical pixels.
  useLayoutEffect(() => {
    periodsRef.current = colRefs.current.map((el) => {
      const copy = el?.firstElementChild as HTMLElement | null;
      return copy ? copy.offsetHeight : 0;
    });
  });

  // Projector marquee: creep every column up forever. Each column wraps at its
  // own period (its content is duplicated), so all screen space stays filled.
  // Viewers can also scroll it: wheel and touch-drag move all columns together
  // (with a momentum fling on release), and auto-scroll resumes 4s after the
  // last interaction. Pauses while a photo is open.
  useEffect(() => {
    if (!animate) {
      posRef.current = [];
      colRefs.current.forEach((el) => {
        if (el) el.style.transform = "";
      });
      return;
    }
    let raf = 0;
    let last: number | null = null;
    let idleUntil = 0;
    let velocity = 0; // px/sec fling from a drag release, decays in step()
    let dragY: number | null = null; // pointer y while dragging, else null
    let lastMoveT = 0;
    const bump = () => {
      idleUntil = performance.now() + 4000;
    };

    const move = (delta: number) => {
      colRefs.current.forEach((el, i) => {
        const period = periodsRef.current[i];
        if (!el || !period) return;
        const pos = wrap((posRef.current[i] ?? 0) + delta, period);
        posRef.current[i] = pos;
        el.style.transform = `translateY(${-pos}px)`;
      });
    };

    const onWheel = (e: WheelEvent) => {
      if (fullRef.current) return;
      bump();
      velocity = 0;
      move(e.deltaY);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (fullRef.current) return;
      bump();
      velocity = 0;
      dragY = e.clientY;
      lastMoveT = performance.now();
      dragDistRef.current = 0;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragY === null || fullRef.current) return;
      bump();
      const dy = dragY - e.clientY;
      dragY = e.clientY;
      const now = performance.now();
      const dt = (now - lastMoveT) / 1000;
      lastMoveT = now;
      if (dt > 0) velocity = dy / dt;
      dragDistRef.current += Math.abs(dy);
      move(dy);
    };
    const onPointerEnd = () => {
      dragY = null;
      bump();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerEnd, { passive: true });
    window.addEventListener("pointercancel", onPointerEnd, { passive: true });
    window.addEventListener("keydown", bump, { passive: true });

    const step = (t: number) => {
      const dt = last === null ? 0 : Math.min((t - last) / 1000, 0.1);
      last = t;
      if (!fullRef.current && dragY === null) {
        if (Math.abs(velocity) > 1) {
          move(velocity * dt);
          velocity *= Math.pow(0.95, dt * 60); // frame-rate-independent decay
          bump(); // keep auto-scroll paused until the fling settles
        } else if (t > idleUntil) {
          velocity = 0;
          move(SPEED * dt);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("keydown", bump);
    };
  }, [animate]);

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

  return (
    <main className={styles.live}>
      {photos.length === 0 && <p className={styles.empty}>Waiting for the first photo…</p>}

      {pageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.qr}
          src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pageUrl)}`}
          alt="Scan to view this live gallery on your phone"
        />
      )}

      <div className={styles.grid}>
        {columns.map((col, i) => {
          // repeat the column's photos until one copy fills the screen, so the
          // two-copy loop never exposes empty space
          const m = animate && heights[i] > 0 ? Math.max(1, Math.ceil(vh / heights[i])) : 1;
          const unit: Photo[] = [];
          for (let k = 0; k < m; k++) unit.push(...col);

          const copy = (prefix: string) => (
            <div key={prefix} className={styles.copy} aria-hidden={prefix === "b" || undefined}>
              {unit.map((p, j) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${prefix}-${j}-${p.url}`}
                  src={p.url}
                  alt=""
                  loading="lazy"
                  className={styles.tile}
                  onClick={() => {
                    if (dragDistRef.current > 10) return; // was a drag, not a tap
                    setFull(p.url);
                  }}
                  onLoad={(e) => {
                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                    if (w > 0) setRatios((mm) => (mm[p.url] ? mm : { ...mm, [p.url]: h / w }));
                  }}
                />
              ))}
            </div>
          );

          return (
            <div key={i} className={styles.col}>
              <div
                className={styles.colInner}
                ref={(el) => {
                  colRefs.current[i] = el;
                }}
              >
                {copy("a")}
                {animate && copy("b")}
              </div>
            </div>
          );
        })}
      </div>

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
