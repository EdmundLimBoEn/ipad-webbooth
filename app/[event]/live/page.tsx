"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { message, SUPPORTED_LOCALES, type SupportedLocale } from "@/app/i18n/catalog";
import {
  applyDocumentLocale,
  deviceLocaleStorageKey,
  resolveDeviceLocale,
} from "@/app/i18n/locale";
import { PROJECTOR_FEED_PROFILE } from "@/app/photo-feed/controller";
import type { FeedPhoto } from "@/app/photo-feed/types";
import { usePhotoFeed } from "@/app/photo-feed/use-photo-feed";
import { PhotoLightbox } from "../gallery/photo-lightbox";
import styles from "./live.module.css";
import {
  MANUAL_PAUSE_MS,
  marqueeTileKey,
  shouldAnimateMarquee,
  suppressActivationAfterDrag,
} from "./marquee";
import { wrap } from "./wrap";

const SPEED = 40; // px/sec
const GAP = 12; // must match the CSS gap/padding-bottom on .copy
const PAD = 14;

export default function Live() {
  const { event } = useParams<{ event: string }>();
  const feed = usePhotoFeed(event, PROJECTOR_FEED_PROFILE);
  const photos = feed.photos;
  const [full, setFull] = useState<FeedPhoto | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  // measured height/width per photo url, so columns can be balanced by real height
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);
  // QR is generated locally — a third-party QR service going down (or being
  // blocked on venue Wi-Fi) must not break how guests find the gallery
  const [qr, setQr] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const galleryUrl = new URL(`/${encodeURIComponent(event)}/gallery`, window.location.origin);
    QRCode.toDataURL(galleryUrl.toString(), { width: 300, margin: 1 })
      .then(setQr)
      .catch(() => {});
  }, [event]);

  useEffect(() => {
    let storedLocale: string | null = null;
    try {
      storedLocale = window.localStorage.getItem(deviceLocaleStorageKey(event));
    } catch {
      // Storage is an enhancement; browser language still provides a locale.
    }
    setLocale(resolveDeviceLocale({
      event,
      configured: SUPPORTED_LOCALES,
      storedLocale,
      navigatorLanguages: navigator.languages,
    }));
  }, [event]);

  useEffect(() => {
    applyDocumentLocale(document.documentElement, locale);
  }, [locale]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
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
  const columns: FeedPhoto[][] = Array.from({ length: cols }, () => []);
  const heights = new Array<number>(cols).fill(0); // px incl. trailing gap
  for (const p of photos) {
    const i = heights.indexOf(Math.min(...heights));
    columns[i].push(p);
    heights[i] += (ratios[p.url] ?? 1) * colW + GAP; // assume square until measured
  }
  const animate = shouldAnimateMarquee({
    reducedMotion,
    viewportHeight: vh,
    tallestColumnHeight: Math.max(0, ...heights),
  });

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
      idleUntil = performance.now() + MANUAL_PAUSE_MS;
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

  return (
    <main className={styles.live} lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      {photos.length === 0 && feed.status === "loading" && <div className={styles.feedStatus}><span className={styles.pulse} /> <p>{message(locale, "galleryBrowseLoading")}</p></div>}
      {photos.length === 0 && feed.status === "ready" && <div className={styles.feedStatus}><strong>{message(locale, "galleryBrowseEmpty")}</strong><p>{message(locale, "galleryBrowseEmptyBody")}</p></div>}
      {feed.status === "error" && <div className={photos.length ? styles.feedToast : styles.feedStatus} role="alert"><strong>{message(locale, "galleryConnectionLost")}</strong><p>{feed.error}</p><button onClick={feed.refresh}>{message(locale, "galleryRetry")}</button></div>}

      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.qr} src={qr} alt={message(locale, "galleryQrAlt")} />
      )}

      <div className={styles.grid}>
        {columns.map((col, i) => {
          // repeat the column's photos until one copy fills the screen, so the
          // two-copy loop never exposes empty space
          const m = animate && heights[i] > 0 ? Math.max(1, Math.ceil(vh / heights[i])) : 1;
          const unit: FeedPhoto[] = [];
          for (let k = 0; k < m; k++) unit.push(...col);

          // key by url + occurrence, not list index: a new photo at the head
          // must not re-key (remount + replay the pop animation on) every
          // tile after it
          const seen = new Map<string, number>();
          const tileKey = (key: string) => {
            const n = seen.get(key) ?? 0;
            seen.set(key, n + 1);
            return marqueeTileKey(key, n);
          };
          const copy = (prefix: string) => (
            <div key={prefix} className={styles.copy} aria-hidden={prefix === "b" || undefined}>
              {unit.map((p) => (
                <button
                  key={tileKey(p.key)}
                  type="button"
                  className={styles.tileButton}
                  tabIndex={prefix === "b" ? -1 : undefined}
                  onClick={() => {
                    if (suppressActivationAfterDrag(dragDistRef.current)) return;
                    setFull(p);
                  }}
                  aria-label={message(locale, "galleryPhotoLabel")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt=""
                    loading="lazy"
                    className={styles.tile}
                    onLoad={(e) => {
                      const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                      if (w > 0) setRatios((mm) => (mm[p.url] ? mm : { ...mm, [p.url]: h / w }));
                    }}
                  />
                </button>
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
        <PhotoLightbox
          event={event}
          photo={full}
          origin={window.location.origin}
          labels={{
            title: message(locale, "galleryLightboxTitle"),
            photoAlt: message(locale, "galleryPhotoAlt"),
            save: message(locale, "gallerySave"),
            share: message(locale, "galleryShare"),
            close: message(locale, "galleryClose"),
            previous: message(locale, "galleryPrevious"),
            next: message(locale, "galleryNext"),
            working: message(locale, "galleryWorking"),
            actionError: message(locale, "galleryActionError"),
          }}
          onClose={() => setFull(null)}
        />
      )}
    </main>
  );
}
