"use client";

import { GROUPS, TEMPLATES } from "../../templates";
import type { Template } from "../../frame-packs/types";
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../../i18n/catalog";
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

type CaptureExperienceControlsProps = {
  enabledLocales: ReadonlySet<SupportedLocale>;
  defaultLocale: SupportedLocale;
  reviewEnabled: boolean;
  autoAcceptSeconds: number;
  countdownAudioDefault: boolean;
  disabled: boolean;
  onToggleLocale: (locale: SupportedLocale) => void;
  onDefaultLocaleChange: (locale: SupportedLocale) => void;
  onReviewEnabledChange: (enabled: boolean) => void;
  onAutoAcceptSecondsChange: (seconds: number) => void;
  onCountdownAudioDefaultChange: (enabled: boolean) => void;
};

const localeNames: Record<SupportedLocale, string> = {
  en: "English",
  "zh-SG": "简体中文",
  ar: "العربية",
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

export function CaptureExperienceControls({
  enabledLocales,
  defaultLocale,
  reviewEnabled,
  autoAcceptSeconds,
  countdownAudioDefault,
  disabled,
  onToggleLocale,
  onDefaultLocaleChange,
  onReviewEnabledChange,
  onAutoAcceptSecondsChange,
  onCountdownAudioDefaultChange,
}: CaptureExperienceControlsProps) {
  return (
    <div className={styles.experienceControls}>
      <fieldset>
        <legend>Enabled guest languages</legend>
        <div className={styles.localeOptions}>
          {SUPPORTED_LOCALES.map((locale) => (
            <label key={locale}>
              <input
                type="checkbox"
                checked={enabledLocales.has(locale)}
                disabled={disabled}
                onChange={() => onToggleLocale(locale)}
              />
              <span lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
                {localeNames[locale]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className={styles.experienceField}>
        <span>Default guest language</span>
        <select
          value={defaultLocale}
          disabled={disabled}
          onChange={(event) => onDefaultLocaleChange(event.target.value as SupportedLocale)}
        >
          {SUPPORTED_LOCALES.filter((locale) => enabledLocales.has(locale)).map((locale) => (
            <option key={locale} value={locale} lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
              {localeNames[locale]}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.experienceToggle}>
        <input
          type="checkbox"
          checked={reviewEnabled}
          disabled={disabled}
          onChange={(event) => onReviewEnabledChange(event.target.checked)}
        />
        <span>Show photo review</span>
      </label>

      <label className={styles.experienceField}>
        <span>Auto-accept after</span>
        <span className={styles.secondsInput}>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={autoAcceptSeconds}
            disabled={disabled}
            onChange={(event) => onAutoAcceptSecondsChange(Number(event.target.value))}
          />
          <span>seconds</span>
        </span>
      </label>

      <label className={styles.experienceToggle}>
        <input
          type="checkbox"
          checked={countdownAudioDefault}
          disabled={disabled}
          onChange={(event) => onCountdownAudioDefaultChange(event.target.checked)}
        />
        <span>Countdown sounds on by default</span>
      </label>
    </div>
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
