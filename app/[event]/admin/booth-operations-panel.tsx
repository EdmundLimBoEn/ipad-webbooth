"use client";

import type { AdminBoothRecord, BoothOperationalState } from "../../booth-control";
import styles from "./admin.module.css";

type BoothOperationsPanelProps = {
  records: readonly AdminBoothRecord[];
  cursor: string | null;
  operationalState: BoothOperationalState | null;
  loading: boolean;
  loadingMore: boolean;
  mutationBusy: boolean;
  hasError: boolean;
  englishMessageDraft: string;
  onEnglishMessageChange: (message: string) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onPause: () => void;
  onResume: () => void;
};

function abbreviatedDeviceId(deviceId: string) {
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}`;
}

function formatTimestamp(timestamp: number | string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function dateTimeValue(timestamp: number | string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function BoothRow({ record }: { record: AdminBoothRecord }) {
  const lastUpload = record.lastSuccessfulUploadAt === undefined
    ? "No upload yet"
    : formatTimestamp(record.lastSuccessfulUploadAt);
  const sessionDateTime = dateTimeValue(record.sessionStartedAt);

  return (
    <li className={styles.boothRow} data-stale={record.stale}>
      <div className={styles.boothRowHead}>
        <code title={record.deviceId}>{abbreviatedDeviceId(record.deviceId)}</code>
        <span className={styles.boothPresence} data-live={!record.stale}>{record.stale ? "Stale" : "Live"}</span>
      </div>
      <dl className={styles.boothFacts}>
        <div><dt>Last seen</dt><dd><time dateTime={record.lastSeenAt}>{formatTimestamp(record.lastSeenAt)}</time></dd></div>
        <div><dt>Session</dt><dd><time dateTime={sessionDateTime}>{formatTimestamp(record.sessionStartedAt)}</time></dd></div>
        <div aria-label={`Pending ${record.pendingCount}`}><dt>Pending</dt><dd>{record.pendingCount}</dd></div>
        <div aria-label={`Storage ${record.durableStorage ? "durable" : "degraded"}`}><dt>Storage</dt><dd>{record.durableStorage ? "Durable" : "Degraded"}</dd></div>
        <div aria-label={record.online ? "Online" : "Offline"}><dt>Network</dt><dd>{record.online ? "Online" : "Offline"}</dd></div>
        <div aria-label={record.installed ? "Installed" : "Browser mode"}><dt>Mode</dt><dd>{record.installed ? "Installed" : "Browser"}</dd></div>
        <div aria-label={`Camera ${record.camera}`}><dt>Camera</dt><dd>{record.camera}</dd></div>
        <div aria-label={`Upload ${record.upload}`}><dt>Upload</dt><dd>{record.upload}</dd></div>
        <div><dt>Last upload</dt><dd>{lastUpload}</dd></div>
        <div aria-label={record.errorClass ? `Error ${record.errorClass}` : "No classified error"}><dt>Error</dt><dd>{record.errorClass ?? "None"}</dd></div>
        <div aria-label={`Build ${record.buildId}`}><dt>Build</dt><dd><code>{record.buildId}</code></dd></div>
      </dl>
    </li>
  );
}

export function BoothOperationsPanel({
  records,
  cursor,
  operationalState,
  loading,
  loadingMore,
  mutationBusy,
  hasError,
  englishMessageDraft,
  onEnglishMessageChange,
  onRefresh,
  onLoadMore,
  onPause,
  onResume,
}: BoothOperationsPanelProps) {
  const paused = operationalState?.paused ?? false;
  const controlsUnavailable = mutationBusy || operationalState === null;
  const actionLabel = mutationBusy
    ? paused ? "Resuming capture…" : "Pausing capture…"
    : paused ? "Resume capture" : "Pause capture";

  return (
    <section className={styles.boothOperations} aria-labelledby="booth-operations-heading">
      <div className={styles.boothOperationsHead}>
        <div>
          <span className={styles.cardNumber}>03</span>
          <h2 id="booth-operations-heading">Booth operations</h2>
          <p>Watch each iPad and stop capture before a problem spreads across the room.</p>
        </div>
        <div className={styles.boothControlState} data-paused={paused}>
          <span>Capture</span>
          <strong>{operationalState === null ? "Checking" : paused ? "Paused" : "Running"}</strong>
        </div>
      </div>

      <div className={styles.boothControlBar}>
        <label htmlFor="booth-english-message">English booth message</label>
        <textarea
          id="booth-english-message"
          value={englishMessageDraft}
          onChange={(event) => onEnglishMessageChange(event.target.value)}
          disabled={controlsUnavailable}
          placeholder="Optional note for booth screens"
          maxLength={280}
          rows={2}
        />
        <div className={styles.boothActions}>
          <button type="button" onClick={onRefresh} disabled={loading || mutationBusy}>
            {loading ? "Refreshing…" : "Refresh stations"}
          </button>
          <button
            className={styles.boothPauseButton}
            type="button"
            onClick={paused ? onResume : onPause}
            disabled={controlsUnavailable}
          >
            {actionLabel}
          </button>
        </div>
      </div>

      {hasError && <p className={styles.boothStatusError} role="status">Booth status needs a refresh.</p>}

      {records.length === 0 && !loading ? (
        <div className={styles.boothEmpty}><strong>No stations have checked in.</strong><p>Open the booth on each iPad to see it here.</p></div>
      ) : (
        <ol className={styles.boothRoster} aria-label="Booth station status">
          {records.map((record) => <BoothRow key={record.deviceId} record={record} />)}
        </ol>
      )}

      {cursor !== null && (
        <button className={styles.boothLoadMore} type="button" onClick={onLoadMore} disabled={loading || loadingMore || mutationBusy}>
          {loadingMore ? "Loading stations…" : "Load more stations"}
        </button>
      )}
    </section>
  );
}
