"use client";

import type { EventExperience } from "../../event-config";
import type { EventPreset } from "../../event-preset";
import {
  isSupportedLocale,
  localeDirection,
  message,
  type SupportedLocale,
} from "../../i18n/catalog";
import { resolveEnabledLocales } from "../../i18n/locale";
import styles from "./admin.module.css";

const localeNames: Record<SupportedLocale, string> = {
  en: "English",
  "zh-SG": "简体中文",
  ar: "العربية",
};

export type PresetPanelProps = {
  locale: SupportedLocale;
  event: string;
  currentExperience: EventExperience;
  presets: readonly EventPreset[];
  selectedPresetId: string | null;
  presetIdDraft: string;
  presetLabelDraft: string;
  loading: boolean;
  loadError: string;
  mutationBusy: boolean;
  saving: boolean;
  applyingPresetId: string | null;
  confirmingPresetId: string | null;
  hasBoothKey: boolean;
  successMessage: string;
  errorMessage: string;
  onPresetIdChange: (value: string) => void;
  onPresetLabelChange: (value: string) => void;
  onSelectPreset: (presetId: string | null) => void;
  onSave: () => void;
  onRequestApply: (presetId: string) => void;
  onConfirmApply: (presetId: string) => void;
  onCancelApply: () => void;
  onReload: () => void;
};

export function PresetPanel({
  locale,
  event,
  currentExperience,
  presets,
  selectedPresetId,
  presetIdDraft,
  presetLabelDraft,
  loading,
  loadError,
  mutationBusy,
  saving,
  applyingPresetId,
  confirmingPresetId,
  hasBoothKey,
  successMessage,
  errorMessage,
  onPresetIdChange,
  onPresetLabelChange,
  onSelectPreset,
  onSave,
  onRequestApply,
  onConfirmApply,
  onCancelApply,
  onReload,
}: PresetPanelProps) {
  const locales = resolveEnabledLocales(currentExperience.locales);
  const defaultLocale =
    isSupportedLocale(currentExperience.defaultLocale)
    && locales.includes(currentExperience.defaultLocale)
    ? currentExperience.defaultLocale
    : "en";
  const reviewEnabled = currentExperience.capture?.reviewEnabled ?? true;
  const autoAcceptSeconds = currentExperience.capture?.autoAcceptSeconds ?? 5;
  const audioEnabled = currentExperience.capture?.countdownAudioDefault ?? false;
  const confirmingPreset = presets.find(({ id }) => id === confirmingPresetId);
  const selectedPreset = presets.find(({ id }) => id === selectedPresetId);
  const disabled = mutationBusy;

  return (
    <section
      className={styles.presetPanel}
      dir={localeDirection(locale)}
      aria-labelledby="preset-panel-title"
    >
      <div className={styles.presetHeading}>
        <div>
          <span className={styles.cardNumber}>03</span>
          <h2 id="preset-panel-title">{message(locale, "presetPanelTitle")}</h2>
        </div>
        <p>{message(locale, "presetPanelDescription")}</p>
      </div>

      <p className={styles.presetPrivacy}>{message(locale, "presetCredentialIsolation")}</p>

      <div className={styles.presetWorkspace}>
        <div className={styles.presetEditor}>
          <label htmlFor="preset-library">{message(locale, "presetLibraryLabel")}</label>
          <div className={styles.presetLibraryRow}>
            <select
              id="preset-library"
              value={selectedPresetId ?? ""}
              disabled={disabled}
              onChange={(event) => onSelectPreset(event.target.value || null)}
            >
              <option value="">{message(locale, "presetSelectPlaceholder")}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
            <button type="button" disabled={disabled} onClick={onReload}>
              {message(locale, "presetReloadAction")}
            </button>
          </div>

          <label htmlFor="preset-id">{message(locale, "presetIdLabel")}</label>
          <input
            id="preset-id"
            value={presetIdDraft}
            disabled={disabled || selectedPreset !== undefined}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => onPresetIdChange(event.target.value)}
          />
          <label htmlFor="preset-label">{message(locale, "presetLabelLabel")}</label>
          <input
            id="preset-label"
            value={presetLabelDraft}
            disabled={disabled}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => onPresetLabelChange(event.target.value)}
          />

          <button
            className={styles.presetSave}
            type="button"
            disabled={disabled || !presetIdDraft.trim() || !presetLabelDraft.trim()}
            onClick={onSave}
          >
            {saving
              ? message(locale, "presetSavingAction")
              : message(
                  locale,
                  selectedPreset ? "presetUpdateAction" : "presetCreateAction",
                )}
          </button>
        </div>

        <div className={styles.presetSummary}>
          <h3>{message(locale, "presetSaveSummaryTitle")}</h3>
          <ul>
            <li>{message(locale, "presetFramesSummary", {
              count: currentExperience.frames.length,
            })}</li>
            <li>{message(locale, "presetLocalesSummary", {
              locales: locales.map((item) => localeNames[item]).join(", "),
            })}</li>
            <li>{message(locale, "presetDefaultLocaleSummary", {
              locale: localeNames[defaultLocale],
            })}</li>
            <li>{message(locale, "presetReviewSummary", {
              state: message(locale, reviewEnabled ? "presetOn" : "presetOff"),
            })}</li>
            <li>{message(locale, "presetAutoAcceptSummary", {
              seconds: autoAcceptSeconds,
            })}</li>
            <li>{message(locale, "presetAudioSummary", {
              state: message(locale, audioEnabled ? "presetOn" : "presetOff"),
            })}</li>
            <li>{message(locale, "presetTimeZoneSummary", {
              timeZone: currentExperience.timeZone ?? message(locale, "presetNotSet"),
            })}</li>
            <li>{message(locale, "presetGalleryTitleSummary", {
              title: currentExperience.gallery?.title ?? message(locale, "presetNotSet"),
            })}</li>
            <li>{message(locale, "presetGalleryAccentSummary", {
              color: currentExperience.gallery?.accentColor ?? message(locale, "presetNotSet"),
            })}</li>
          </ul>
        </div>
      </div>

      {loading ? (
        <p className={styles.presetEmpty}>{message(locale, "presetLoading")}</p>
      ) : loadError ? (
        <p className={styles.presetLoadError}>{message(locale, "presetLoadError")}</p>
      ) : presets.length === 0 ? (
        <p className={styles.presetEmpty}>{message(locale, "presetEmpty")}</p>
      ) : (
        <ul className={styles.presetList}>
          {presets.map((preset) => (
            <li key={preset.id} data-selected={preset.id === selectedPresetId}>
              <div>
                <strong>{preset.label}</strong>
                <bdi><code>{preset.id}</code></bdi>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRequestApply(preset.id)}
              >
                {applyingPresetId === preset.id
                  ? message(locale, "presetApplyingAction")
                  : message(locale, "presetReviewApplyAction")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirmingPreset && (
        <div className={styles.presetConfirm} role="group" aria-label={message(
          locale,
          "presetApplyAction",
        )}>
          <p>{message(locale, "presetApplyConfirmation", {
            event,
            preset: confirmingPreset.label,
          })}</p>
          <p className={styles.presetExact}>
            <bdi><code>{confirmingPreset.id}</code></bdi>
          </p>
          {!hasBoothKey && (
            <p className={styles.presetWarning}>{message(locale, "presetMissingBoothKey")}</p>
          )}
          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onConfirmApply(confirmingPreset.id)}
            >
              {applyingPresetId === confirmingPreset.id
                ? message(locale, "presetApplyingAction")
                : message(locale, "presetApplyAction")}
            </button>
            <button type="button" disabled={disabled} onClick={onCancelApply}>
              {message(locale, "presetCancelAction")}
            </button>
          </div>
        </div>
      )}

      <p className={styles.presetStatus} aria-live="polite" aria-atomic="true">
        {successMessage}
      </p>
      <p className={styles.presetError} role="alert">{errorMessage}</p>
    </section>
  );
}
