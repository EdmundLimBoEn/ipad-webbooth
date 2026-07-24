"use client";

import { GROUPS, TEMPLATES } from "../../templates";
import type { Template } from "../../frame-packs/types";
import styles from "./admin.module.css";

type FrameProgrammeControlsProps = {
  frames: ReadonlySet<string>;
  defaults: readonly string[];
  disabled: boolean;
  onToggle: (key: string) => void;
  onSetGroup: (group: string, enabled: boolean) => void;
};

type BoothKeyControlsProps = {
  value: string;
  saved: boolean;
  copied: boolean;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onCopy: () => void;
  onClear: () => void;
};

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

function FrameCard({
  frameKey,
  enabled,
  disabled,
  onToggle,
}: {
  frameKey: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: (key: string) => void;
}) {
  const frame = TEMPLATES[frameKey];
  return (
    <label className={styles.frameCard} data-enabled={enabled} data-disabled={disabled}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        onChange={() => onToggle(frameKey)}
      />
      <FramePreview frame={frame} />
      <span className={styles.frameMeta}>
        <strong>{frame.label}</strong>
        <small>{frame.shots} shot{frame.shots === 1 ? "" : "s"} / {frame.canvas.w}×{frame.canvas.h}</small>
      </span>
      <span className={styles.frameCheck}>{enabled ? "ON" : "OFF"}</span>
    </label>
  );
}

export function FrameProgrammeControls({
  frames,
  defaults,
  disabled,
  onToggle,
  onSetGroup,
}: FrameProgrammeControlsProps) {
  return (
    <div className={styles.frameGroups}>
      <div className={styles.frameGroup}>
        <div className={styles.groupHead}><h3>House frames</h3></div>
        <div className={styles.filmRail}>
          {defaults.map((key) => (
            <FrameCard
              key={key}
              frameKey={key}
              enabled={frames.has(key)}
              disabled={disabled}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
      {Object.entries(GROUPS).map(([group, label]) => {
        const keys = Object.keys(TEMPLATES).filter((key) => TEMPLATES[key].group === group);
        const allOn = keys.every((key) => frames.has(key));
        return (
          <div className={styles.frameGroup} key={group}>
            <div className={styles.groupHead}>
              <h3>{label}</h3>
              <button
                type="button"
                onClick={() => onSetGroup(group, !allOn)}
                disabled={disabled}
              >
                {allOn ? "Disable pack" : "Enable pack"}
              </button>
            </div>
            <div className={styles.filmRail}>
              {keys.map((key) => (
                <FrameCard
                  key={key}
                  frameKey={key}
                  enabled={frames.has(key)}
                  disabled={disabled}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BoothKeyControls({
  value,
  saved,
  copied,
  disabled,
  placeholder,
  onChange,
  onGenerate,
  onCopy,
  onClear,
}: BoothKeyControlsProps) {
  return (
    <>
      <div className={styles.keyRow}>
        <input
          aria-label="New booth key"
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
        />
        <button type="button" onClick={onGenerate} disabled={disabled}>Generate</button>
      </div>
      {value && (
        <button className={styles.copyWide} type="button" onClick={onCopy}>
          {copied ? "Copied ✓" : "Copy generated key"}
        </button>
      )}
      {value && saved && (
        <button className={styles.clearKey} type="button" onClick={onClear} disabled={disabled}>
          Stored safely — clear key
        </button>
      )}
    </>
  );
}

export function SaveConfigurationButton({
  disabled,
  saving,
  onSave,
}: {
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <button
      className={styles.saveButton}
      type="button"
      onClick={onSave}
      disabled={disabled}
    >
      {saving ? "Saving event…" : "Save configuration"}
    </button>
  );
}
