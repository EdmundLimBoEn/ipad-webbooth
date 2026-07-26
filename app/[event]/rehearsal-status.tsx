"use client";

import type { SupportedLocale } from "../i18n/catalog";
import { message } from "../i18n/catalog";
import type { RehearsalClientState } from "./booth-session/rehearsal-client";
import styles from "./booth.module.css";

export function RehearsalStatus({
  locale,
  state,
  currentFrame,
  onLeave,
}: {
  locale: SupportedLocale;
  state: RehearsalClientState;
  currentFrame: string | null;
  onLeave: () => void;
}) {
  const rehearsal = state.rehearsal;
  if (!rehearsal) return null;
  const covered = currentFrame ? rehearsal.frames.includes(currentFrame) : false;
  return (
    <aside className={styles.rehearsalStatus} aria-labelledby="rehearsal-status-title">
      <div>
        <p>{message(locale, "rehearsalOperatorContext")}</p>
        <h2 id="rehearsal-status-title">{message(locale, "rehearsalBoothTitle")}</h2>
        <bdi><code>{rehearsal.id}</code></bdi>
      </div>
      {rehearsal.stale && (
        <p className={styles.rehearsalWarning} role="alert">
          {message(locale, "rehearsalStaleBooth")}
        </p>
      )}
      <dl>
        <div>
          <dt>{message(locale, "rehearsalFrameCoverage")}</dt>
          <dd>{covered ? message(locale, "rehearsalCovered") : message(locale, "rehearsalNeedsCapture")}</dd>
        </div>
        <div>
          <dt>{message(locale, "rehearsalPendingEvidence")}</dt>
          <dd>{state.pendingEvidence}</dd>
        </div>
      </dl>
      {!state.durable && (
        <p className={styles.rehearsalWarning} role="alert">
          {message(locale, "rehearsalEvidenceNotDurable")}
        </p>
      )}
      <p>{message(locale, rehearsal.stale ? "rehearsalDrainGuidance" : "rehearsalNextStep")}</p>
      <button type="button" onClick={onLeave}>{message(locale, "rehearsalLeave")}</button>
    </aside>
  );
}
