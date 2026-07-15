"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FRAME_PACKS } from "../frame-packs/catalog";
import type { FrameDefinition, Slot } from "../frame-packs/types";
import styles from "./frame-lab.module.css";

type Selection = { pack: string; key: string; frame: FrameDefinition };
type Drag = { index: number; mode: "move" | "resize"; startX: number; startY: number; slot: Slot };

const selections: Selection[] = FRAME_PACKS.flatMap((manifest) =>
  Object.entries(manifest.templates).map(([key, frame]) => ({ pack: manifest.pack.key, key, frame })),
);

export default function FrameLab() {
  const [selected, setSelected] = useState(selections[0]);
  const [frame, setFrame] = useState<FrameDefinition>(() => clone(selections[0].frame));
  const [localArt, setLocalArt] = useState<{ url: string; name: string; layer: "bgImage" | "overlay" } | null>(null);
  const [copied, setCopied] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    let active = true;
    void renderComposite(canvasRef.current, selected.pack, frame, localArt).catch(() => active && undefined);
    return () => { active = false; };
  }, [selected.pack, frame, localArt]);

  useEffect(() => () => { if (localArt) URL.revokeObjectURL(localArt.url); }, [localArt]);

  const manifest = useMemo(() => JSON.stringify({
    version: 1,
    pack: { key: selected.pack, label: FRAME_PACKS.find((pack) => pack.pack.key === selected.pack)?.pack.label },
    templates: { [selected.key]: serializableFrame(frame, localArt) },
  }, null, 2), [selected, frame, localArt]);

  function choose(value: string) {
    const next = selections.find((item) => `${item.pack}/${item.key}` === value)!;
    if (localArt) URL.revokeObjectURL(localArt.url);
    setLocalArt(null);
    setSelected(next);
    setFrame(clone(next.frame));
  }

  function changeSlot(index: number, field: keyof Slot, value: string) {
    const numeric = Math.max(0, Math.round(Number(value) || 0));
    setFrame((current) => ({
      ...current,
      slots: current.slots.map((slot, i) => i === index ? { ...slot, [field]: numeric } : slot),
      shots: current.slots.length,
    }));
  }

  function startDrag(event: React.PointerEvent, index: number, mode: Drag["mode"]) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { index, mode, startX: event.clientX, startY: event.clientY, slot: { ...frame.slots[index] } };
  }

  function drag(event: React.PointerEvent) {
    const active = dragRef.current;
    const stage = stageRef.current;
    if (!active || !stage) return;
    const rect = stage.getBoundingClientRect();
    const dx = Math.round((event.clientX - active.startX) * frame.canvas.w / rect.width);
    const dy = Math.round((event.clientY - active.startY) * frame.canvas.h / rect.height);
    setFrame((current) => ({ ...current, slots: current.slots.map((slot, index) => {
      if (index !== active.index) return slot;
      if (active.mode === "move") return {
        ...slot,
        x: clamp(active.slot.x + dx, 0, current.canvas.w - slot.w),
        y: clamp(active.slot.y + dy, 0, current.canvas.h - slot.h),
      };
      return {
        ...slot,
        w: clamp(active.slot.w + dx, 1, current.canvas.w - slot.x),
        h: clamp(active.slot.h + dy, 1, current.canvas.h - slot.y),
      };
    }) }));
  }

  function addSlot() {
    setFrame((current) => {
      const w = Math.round(current.canvas.w * 0.6);
      const h = Math.round(current.canvas.h * 0.3);
      const slots = [...current.slots, { x: Math.round((current.canvas.w - w) / 2), y: Math.round((current.canvas.h - h) / 2), w, h }];
      return { ...current, slots, shots: slots.length };
    });
  }

  function removeSlot(index: number) {
    setFrame((current) => {
      const slots = current.slots.filter((_, i) => i !== index);
      return slots.length ? { ...current, slots, shots: slots.length } : current;
    });
  }

  async function copyManifest() {
    await navigator.clipboard.writeText(manifest);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function downloadManifest() {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([`${manifest}\n`], { type: "application/json" }));
    anchor.download = "manifest.json";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  return (
    <main className={styles.lab}>
      <header className={styles.header}>
        <div><span className={styles.kicker}>Frame authoring tool</span><h1>Calibration light table</h1></div>
        <p>Place each photo opening over the artwork. The exported manifest uses exact canvas pixels.</p>
      </header>

      <section className={styles.workspace}>
        <aside className={styles.controls}>
          <label className={styles.field}>Frame pack
            <select value={`${selected.pack}/${selected.key}`} onChange={(event) => choose(event.target.value)}>
              {selections.map((item) => <option key={`${item.pack}/${item.key}`} value={`${item.pack}/${item.key}`}>{item.pack} / {item.frame.label}</option>)}
            </select>
          </label>
          <div className={styles.artRow}>
            <label className={styles.field}>Artwork layer
              <select defaultValue="bgImage" id="art-layer"><option value="bgImage">Behind photos</option><option value="overlay">Over photos</option></select>
            </label>
            <label className={styles.fileButton}>Load PNG
              <input type="file" accept="image/png" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (localArt) URL.revokeObjectURL(localArt.url);
                const layer = (document.getElementById("art-layer") as HTMLSelectElement).value as "bgImage" | "overlay";
                setLocalArt({ url: URL.createObjectURL(file), name: file.name, layer });
              }} />
            </label>
          </div>
          <div className={styles.canvasReadout}><span>Canvas</span><strong>{frame.canvas.w} × {frame.canvas.h}</strong></div>
          <div className={styles.slotHeading}><h2>Photo openings</h2><button onClick={addSlot}>+ Add</button></div>
          <div className={styles.slotList}>
            {frame.slots.map((slot, index) => (
              <fieldset key={index} className={styles.slotCard}>
                <legend>Slot {index + 1}</legend>
                {(["x", "y", "w", "h"] as const).map((field) => <label key={field}>{field.toUpperCase()}<input type="number" min="0" value={slot[field]} onChange={(event) => changeSlot(index, field, event.target.value)} /></label>)}
                <label>Fit<select value={slot.fit || frame.fit || "cover"} onChange={(event) => setFrame((current) => ({ ...current, slots: current.slots.map((item, i) => i === index ? { ...item, fit: event.target.value as "cover" | "contain" } : item) }))}><option value="cover">Cover</option><option value="contain">Contain</option></select></label>
                <button className={styles.remove} disabled={frame.slots.length === 1} onClick={() => removeSlot(index)}>Remove</button>
              </fieldset>
            ))}
          </div>
        </aside>

        <div className={styles.previewColumn}>
          <div className={styles.previewBar}><span>Composite preview</span><span>Drag to move · corner to resize</span></div>
          <div className={styles.stageShell}>
            <div ref={stageRef} className={styles.stage} style={{ aspectRatio: `${frame.canvas.w}/${frame.canvas.h}` }}>
              <canvas ref={canvasRef} width={frame.canvas.w} height={frame.canvas.h} />
              {frame.slots.map((slot, index) => <div
                key={index}
                className={styles.slotBox}
                style={{ left: `${slot.x / frame.canvas.w * 100}%`, top: `${slot.y / frame.canvas.h * 100}%`, width: `${slot.w / frame.canvas.w * 100}%`, height: `${slot.h / frame.canvas.h * 100}%` }}
                onPointerDown={(event) => startDrag(event, index, "move")}
                onPointerMove={drag}
                onPointerUp={() => { dragRef.current = null; }}
              ><span>{index + 1}</span><button aria-label={`Resize slot ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); startDrag(event, index, "resize"); }} onPointerMove={drag} onPointerUp={() => { dragRef.current = null; }} /></div>)}
            </div>
          </div>
        </div>

        <aside className={styles.output}>
          <div><span className={styles.kicker}>Ready for the design drop</span><h2>Manifest JSON</h2></div>
          <pre>{manifest}</pre>
          <div className={styles.actions}><button onClick={copyManifest}>{copied ? "Copied" : "Copy JSON"}</button><button onClick={downloadManifest}>Download</button></div>
          <p>Keep this file beside the PNG artwork in <code>public/templates/{selected.pack}/</code>, then run the validator.</p>
        </aside>
      </section>
    </main>
  );
}

function clone(frame: FrameDefinition): FrameDefinition { return JSON.parse(JSON.stringify(frame)); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function serializableFrame(frame: FrameDefinition, art: { name: string; layer: "bgImage" | "overlay" } | null) {
  return art ? { ...frame, [art.layer]: art.name } : frame;
}

async function renderComposite(canvas: HTMLCanvasElement | null, pack: string, frame: FrameDefinition, localArt: { url: string; layer: "bgImage" | "overlay" } | null) {
  if (!canvas) return;
  canvas.width = frame.canvas.w; canvas.height = frame.canvas.h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = frame.background || "#dfe4e8"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bg = localArt?.layer === "bgImage" ? localArt.url : frame.bgImage && `/templates/${pack}/${frame.bgImage}`;
  if (bg) ctx.drawImage(await image(bg), 0, 0, canvas.width, canvas.height);
  frame.slots.forEach((slot, index) => {
    const gradient = ctx.createLinearGradient(slot.x, slot.y, slot.x + slot.w, slot.y + slot.h);
    const colors = [["#f6b94a", "#d64d68"], ["#4db9a8", "#315b91"], ["#ad88dd", "#e56554"]][index % 3];
    gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
    ctx.fillStyle = gradient; ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
    ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.beginPath(); ctx.arc(slot.x + slot.w * .5, slot.y + slot.h * .38, Math.min(slot.w, slot.h) * .11, 0, Math.PI * 2); ctx.fill();
  });
  const overlay = localArt?.layer === "overlay" ? localArt.url : frame.overlay && `/templates/${pack}/${frame.overlay}`;
  if (overlay) ctx.drawImage(await image(overlay), 0, 0, canvas.width, canvas.height);
}

function image(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const result = new Image(); result.onload = () => resolve(result); result.onerror = reject; result.src = src; });
}
