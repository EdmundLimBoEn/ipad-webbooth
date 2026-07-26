"use client";

import { useState, type FormEvent } from "react";
import styles from "./booth.module.css";

export type OperatorExitResult = "exited" | "rejected";

export type VerifiedOperatorExitDependencies = {
  verify: (key: string) => Promise<boolean>;
  stopCamera: () => void;
  releaseWake: () => Promise<void>;
  stopHeartbeat: () => void;
  stopPoller: () => void;
  stopSession: () => Promise<void>;
  clearCredentials: () => void;
  clearActiveCredential: () => void;
  markExited: () => void;
};

async function settle(action: () => void | Promise<void>) {
  try {
    await action();
  } catch {
    // A failed resource adapter must not prevent the remaining verified exit
    // teardown or leave credentials resident.
  }
}

export async function performVerifiedOperatorExit(
  key: string,
  deps: VerifiedOperatorExitDependencies
): Promise<OperatorExitResult> {
  let verified = false;
  try {
    verified = await deps.verify(key);
  } catch {
    return "rejected";
  }
  if (!verified) return "rejected";

  await settle(deps.stopCamera);
  await settle(deps.releaseWake);
  await settle(deps.stopHeartbeat);
  await settle(deps.stopPoller);
  await settle(deps.stopSession);
  await settle(deps.clearCredentials);
  await settle(deps.clearActiveCredential);
  await settle(deps.markExited);
  return "exited";
}

export type OperatorControlsProps = {
  event: string;
  pendingCount: number;
  onOperatorGesture: () => void;
  onExit: (freshKey: string) => Promise<OperatorExitResult>;
};

export function OperatorControls({
  event,
  pendingCount,
  onOperatorGesture,
  onExit,
}: OperatorControlsProps) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [rejected, setRejected] = useState(false);

  const toggle = () => {
    onOperatorGesture();
    setRejected(false);
    setOpen((value) => !value);
  };

  const submit = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    if (!key || checking) return;
    const submittedKey = key;
    setKey("");
    setChecking(true);
    setRejected(false);
    const result = await onExit(submittedKey);
    setChecking(false);
    if (result === "rejected") setRejected(true);
  };

  return (
    <aside className={styles.operatorControls}>
      <button
        type="button"
        className={styles.operatorToggle}
        aria-expanded={open}
        aria-controls="operator-exit-panel"
        onClick={toggle}
      >
        Operator
      </button>
      <form
        id="operator-exit-panel"
        className={styles.operatorPanel}
        onSubmit={submit}
        hidden={!open}
      >
          <p className={styles.operatorEyebrow}>Event operator · {event}</p>
          <h2>Exit Booth</h2>
          <p>
            Enter a fresh Booth or Admin Key. {pendingCount} pending photo
            {pendingCount === 1 ? "" : "s"} will stay in the Photo Outbox.
          </p>
          <label htmlFor="operator-exit-key">Booth or Admin Key</label>
          <input
            id="operator-exit-key"
            type="password"
            autoComplete="current-password"
            value={key}
            disabled={checking}
            onChange={(event) => setKey(event.target.value)}
          />
          {rejected && (
            <p className={styles.operatorError} role="alert">
              Key rejected. Booth operation has not changed.
            </p>
          )}
          <div className={styles.operatorActions}>
            <button type="button" onClick={toggle} disabled={checking}>
              Cancel
            </button>
            <button type="submit" disabled={checking || key.length === 0}>
              {checking ? "Verifying…" : "Verify and exit"}
            </button>
          </div>
      </form>
    </aside>
  );
}
