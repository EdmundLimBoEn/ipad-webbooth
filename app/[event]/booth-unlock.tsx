"use client";

import { useEffect, useReducer, type FormEvent } from "react";
import type { BoothAccessState } from "./booth-session/access";
import type { BoothAccessFeedback } from "./booth-session/lifecycle";
import styles from "./booth.module.css";

type UnlockState = Extract<
  BoothAccessState,
  "locked" | "checking" | "recovery-only" | "unavailable"
>;

export type BoothUnlockProps = {
  event: string;
  state: UnlockState;
  feedback?: BoothAccessFeedback;
  pendingCount: number;
  durable: boolean;
  outboxRecovered?: boolean;
  onUnlock: (key: string, remember: boolean) => void;
  onRetry: () => void;
};

export type UnlockFormState = {
  event: string;
  key: string;
  remember: boolean;
};

export type UnlockFormEvent =
  | { type: "event-changed"; event: string }
  | { type: "key-changed"; key: string }
  | { type: "remember-changed"; remember: boolean }
  | { type: "submitted" };

export function createUnlockFormState(event: string): UnlockFormState {
  return { event, key: "", remember: false };
}

export function unlockFormReducer(
  state: UnlockFormState,
  event: UnlockFormEvent
): UnlockFormState {
  if (event.type === "event-changed") {
    return event.event === state.event ? state : createUnlockFormState(event.event);
  }
  if (event.type === "key-changed") return { ...state, key: event.key };
  if (event.type === "remember-changed") {
    return { ...state, remember: event.remember };
  }
  return { ...state, key: "" };
}

function pendingLabel(pendingCount: number) {
  if (pendingCount === 0) return "No photos waiting";
  return `${pendingCount} photo${pendingCount === 1 ? "" : "s"} waiting safely`;
}

export function BoothUnlock({
  event,
  state,
  feedback = state === "checking"
    ? "checking"
    : state === "recovery-only"
      ? "network"
      : state === "unavailable"
        ? "unavailable"
        : "locked",
  pendingCount,
  durable,
  outboxRecovered = true,
  onUnlock,
  onRetry,
}: BoothUnlockProps) {
  const [form, dispatch] = useReducer(
    unlockFormReducer,
    event,
    createUnlockFormState
  );
  const checking = state === "checking" || !outboxRecovered;

  useEffect(() => {
    dispatch({ type: "event-changed", event });
  }, [event]);

  const submit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    const submittedKey = form.key;
    dispatch({ type: "submitted" });
    if (submittedKey) onUnlock(submittedKey, form.remember);
  };

  const accessMessage = feedback === "rejected-key"
    ? "Booth Key rejected. Enter the current key and try again."
    : feedback === "checking"
      ? "Checking Booth access online."
      : feedback === "network"
        ? "Could not reach Booth service. Pending photos are still safe."
        : feedback === "unavailable"
          ? "This Event is not ready for Booth capture."
          : feedback === "recovering"
            ? "Recovering photos saved on this iPad."
            : "Booth is locked.";

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

        <div
          className={styles.unlockStatus}
          role={feedback === "rejected-key" ? "alert" : "status"}
          aria-live={feedback === "rejected-key" ? "assertive" : "polite"}
        >
          <strong>{pendingLabel(pendingCount)}</strong>
          <span>{accessMessage}</span>
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
              value={form.key}
              onChange={(inputEvent) =>
                dispatch({ type: "key-changed", key: inputEvent.target.value })
              }
            />
            <label className={styles.remember}>
              <input
                type="checkbox"
                checked={form.remember}
                disabled={checking}
                onChange={(inputEvent) =>
                  dispatch({
                    type: "remember-changed",
                    remember: inputEvent.target.checked,
                  })
                }
              />
              <span>Remember on this iPad</span>
            </label>
            <button type="submit" disabled={checking || form.key.length === 0}>
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
