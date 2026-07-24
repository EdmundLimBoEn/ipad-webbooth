"use client";

import { useState, type FormEvent } from "react";
import type { BoothAccessState } from "./booth-session/access";
import styles from "./booth.module.css";

type UnlockState = Extract<
  BoothAccessState,
  "locked" | "checking" | "recovery-only" | "unavailable"
>;

export type BoothUnlockProps = {
  event: string;
  state: UnlockState;
  pendingCount: number;
  durable: boolean;
  outboxRecovered?: boolean;
  onUnlock: (key: string, remember: boolean) => void;
  onRetry: () => void;
};

function pendingLabel(pendingCount: number) {
  if (pendingCount === 0) return "No photos waiting";
  return `${pendingCount} photo${pendingCount === 1 ? "" : "s"} waiting safely`;
}

export function BoothUnlock({
  event,
  state,
  pendingCount,
  durable,
  outboxRecovered = true,
  onUnlock,
  onRetry,
}: BoothUnlockProps) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const checking = state === "checking" || !outboxRecovered;

  const submit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    const submittedKey = key;
    setKey("");
    if (submittedKey) onUnlock(submittedKey, remember);
  };

  const title = !outboxRecovered
    ? "Recovering saved photos"
    : state === "checking"
      ? "Checking Booth access"
      : state === "recovery-only"
        ? "Connection needed"
        : state === "unavailable"
          ? "Booth unavailable"
          : "Unlock Booth";

  return (
    <section className={styles.unlock} aria-labelledby="booth-unlock-title">
      <div className={styles.unlockPanel}>
        <header className={styles.unlockHeader}>
          <p className={styles.unlockEyebrow}>Event operator · {event}</p>
          <h1 id="booth-unlock-title">{title}</h1>
          <p className={styles.unlockLead}>
            {!outboxRecovered
              ? "Checking this iPad for photos that still need to upload."
              : state === "locked"
                ? "Enter the Booth Key to prepare this iPad for guests."
                : state === "checking"
                  ? "Confirming the Event and enabled Frames."
                  : state === "recovery-only"
                    ? "Connect this iPad to the internet before taking new photos."
                    : "Check the Event setup, then try again."}
          </p>
        </header>

        <div className={styles.readinessRail} aria-label="Booth readiness">
          <div data-ready={outboxRecovered}>
            <span>Photo Outbox</span>
            <strong>{outboxRecovered ? pendingLabel(pendingCount) : "Recovering"}</strong>
          </div>
          <div data-ready={false}>
            <span>Booth access</span>
            <strong>
              {state === "checking"
                ? "Checking"
                : state === "locked"
                  ? "Locked"
                  : state === "recovery-only"
                    ? "Offline"
                    : "Unavailable"}
            </strong>
          </div>
          <div data-ready={false}>
            <span>Camera</span>
            <strong>Waiting</strong>
          </div>
        </div>

        <div className={styles.unlockStatus} role="status" aria-live="polite">
          <strong>{pendingLabel(pendingCount)}</strong>
          <span>
            {durable
              ? "Saved photos stay on this iPad until upload succeeds."
              : "Keep this page open. Reload recovery is unavailable on this iPad."}
          </span>
        </div>

        {state === "locked" ? (
          <form className={styles.unlockForm} onSubmit={submit}>
            <label htmlFor="booth-key">Booth Key</label>
            <input
              id="booth-key"
              name="booth-key"
              type="password"
              autoComplete="current-password"
              required
              disabled={checking}
              value={key}
              onChange={(inputEvent) => setKey(inputEvent.target.value)}
            />
            <label className={styles.remember}>
              <input
                type="checkbox"
                checked={remember}
                disabled={checking}
                onChange={(inputEvent) => setRemember(inputEvent.target.checked)}
              />
              <span>Remember on this iPad</span>
            </label>
            <button type="submit" disabled={checking || key.length === 0}>
              Unlock Booth
            </button>
          </form>
        ) : state === "recovery-only" || state === "unavailable" ? (
          <button className={styles.unlockRetry} type="button" onClick={onRetry}>
            Try again
          </button>
        ) : (
          <button className={styles.unlockRetry} type="button" disabled>
            Checking…
          </button>
        )}
      </div>
    </section>
  );
}
