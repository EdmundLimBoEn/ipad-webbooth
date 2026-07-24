"use client";

import { useState } from "react";
import type { ConfigRevision } from "../../event-config";
import styles from "./admin.module.css";

export type ConfigHistoryPanelProps = {
  currentFrames: readonly string[];
  currentRevisionId: string | null;
  revisions: readonly ConfigRevision[];
  loading: boolean;
  restoringRevisionId: string | null;
  mutationBusy: boolean;
  error: string;
  onReload: () => void;
  onRestore: (revisionId: string) => void;
};

export function diffFrameKeys(
  current: readonly string[],
  historical: readonly string[]
) {
  return {
    added: historical.filter((key) => !current.includes(key)),
    removed: current.filter((key) => !historical.includes(key)),
  };
}

const reasonLabel: Record<ConfigRevision["reason"], string> = {
  baseline: "Baseline",
  save: "Saved",
  restore: "Restored",
  preset: "Preset",
};

export function ConfigHistoryPanel({
  currentFrames,
  currentRevisionId,
  revisions,
  loading,
  restoringRevisionId,
  mutationBusy,
  error,
  onReload,
  onRestore,
}: ConfigHistoryPanelProps) {
  const [confirmRevisionId, setConfirmRevisionId] = useState<string | null>(null);

  return (
    <section className={styles.historySection} aria-labelledby="configuration-history-title">
      <div className={styles.sectionHead}>
        <div><span>02</span><h2 id="configuration-history-title">Configuration history</h2></div>
        <p>Review each recorded exposure, or restore an earlier Frame selection.</p>
      </div>

      {error ? (
        <div className={styles.failure}>
          <strong>History unavailable</strong>
          <p>{error}</p>
          <button type="button" onClick={onReload}>Reload history</button>
        </div>
      ) : loading ? (
        <p className={styles.historyLoading}>Loading configuration history…</p>
      ) : revisions.length === 0 ? (
        <div className={styles.emptySheet}>
          <strong>No revisions yet.</strong>
          <p>Your first saved configuration will appear here.</p>
        </div>
      ) : (
        <ol className={styles.revisionRail}>
          {revisions.map((revision, index) => {
            const isCurrent = revision.id === currentRevisionId;
            const isRestoring = revision.id === restoringRevisionId;
            const isConfirming = revision.id === confirmRevisionId;
            const frameDiff = diffFrameKeys(currentFrames, revision.config.frames);
            const timestamp = new Date(revision.createdAt);
            const readableTime = timestamp.toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            });

            return (
              <li className={styles.revisionRecord} key={revision.id} data-current={isCurrent}>
                <div className={styles.revisionIndex} aria-hidden="true">
                  <span>R{String(revisions.length - index).padStart(2, "0")}</span>
                </div>
                <div className={styles.revisionDetails}>
                  <div className={styles.revisionHeadline}>
                    <time dateTime={revision.createdAt}>{readableTime}</time>
                    <strong>{reasonLabel[revision.reason]}</strong>
                    {isCurrent && <span className={styles.currentStamp}>Current</span>}
                  </div>
                  <code title={revision.id}>{revision.id}</code>
                  <div className={styles.revisionDelta}>
                    <span>{revision.config.frames.length} Frame{revision.config.frames.length === 1 ? "" : "s"}</span>
                    {frameDiff.added.map((key) => <span data-delta="added" key={`add-${key}`}>+ {key}</span>)}
                    {frameDiff.removed.map((key) => <span data-delta="removed" key={`remove-${key}`}>− {key}</span>)}
                    {!isCurrent && frameDiff.added.length === 0 && frameDiff.removed.length === 0 && (
                      <span data-delta="same">Same Frames</span>
                    )}
                  </div>
                </div>
                <div className={styles.revisionAction}>
                  {isConfirming && !isCurrent ? (
                    <div className={styles.restoreConfirm}>
                      <p>Restore revision {revision.id} from <time dateTime={revision.createdAt}>{readableTime}</time>?</p>
                      <button
                        type="button"
                        onClick={() => {
                          if (mutationBusy) return;
                          setConfirmRevisionId(null);
                          onRestore(revision.id);
                        }}
                        disabled={mutationBusy}
                      >
                        {isRestoring ? "Restoring…" : "Confirm exact restore"}
                      </button>
                      <button type="button" onClick={() => setConfirmRevisionId(null)}>
                        Keep current
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.restoreButton}
                      onClick={() => {
                        if (mutationBusy) return;
                        setConfirmRevisionId(revision.id);
                      }}
                      disabled={isCurrent || mutationBusy}
                    >
                      {isCurrent ? "Current" : isRestoring ? "Restoring…" : "Restore this version"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
