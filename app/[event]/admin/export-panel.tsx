"use client";

import { useState } from "react";
import {
  localeDirection,
  message,
  type SupportedLocale,
} from "../../i18n/catalog";
import {
  downloadAdminExport,
  ExportDownloadError,
  type AdminExportMode,
  type ExportDownloadDeps,
  type SaveFileHandle,
} from "./export-client";
import styles from "./admin.module.css";

export type ExportPanelProps = {
  event: string;
  adminKey: string;
  locale: SupportedLocale;
  onUnauthorized: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandle>;
};

function browserDownloadDeps(): ExportDownloadDeps {
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  return {
    fetch: window.fetch.bind(window),
    ...(picker
      ? {
        pickFile: (suggestedName: string) => picker({
          suggestedName,
          types: [{
            description: "ZIP archive",
            accept: { "application/zip": [".zip"] },
          }],
        }),
      }
      : {}),
    fallback(blob, suggestedName) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggestedName;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
}

function errorMessage(locale: SupportedLocale, status: number): string {
  if (status === 413) return message(locale, "exportTooLarge");
  if (status === 422) return message(locale, "exportMetadataInvalid");
  if (status === 503) return message(locale, "exportUnavailable");
  return message(locale, "exportGenericError");
}

export function ExportPanel({
  event,
  adminKey,
  locale,
  onUnauthorized,
  onNotice,
  onError,
}: ExportPanelProps) {
  const [activeMode, setActiveMode] = useState<AdminExportMode | null>(null);

  const download = async (mode: AdminExportMode) => {
    if (activeMode !== null) return;
    setActiveMode(mode);
    onError("");
    try {
      await downloadAdminExport(
        { event, adminKey, mode },
        browserDownloadDeps(),
      );
      onNotice(message(
        locale,
        mode === "package" ? "exportPackageDone" : "exportPhotosDone",
      ));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ExportDownloadError) {
        if (error.status === 401) {
          onUnauthorized();
          return;
        }
        onError(errorMessage(locale, error.status));
        return;
      }
      onError(message(locale, "exportGenericError"));
    } finally {
      setActiveMode(null);
    }
  };

  const busyText = activeMode === "package"
    ? message(locale, "exportPackageBusy")
    : activeMode === "photos"
      ? message(locale, "exportPhotosBusy")
      : "";

  return (
    <section
      className={styles.exportPanel}
      dir={localeDirection(locale)}
      aria-labelledby="post-event-export-title"
    >
      <span className={styles.cardNumber}>07</span>
      <h2 id="post-event-export-title">{message(locale, "exportPanelTitle")}</h2>
      <p>{message(locale, "exportPanelDescription")}</p>
      <p className={styles.exportHint}>{message(locale, "exportDesktopHint")}</p>
      <div className={styles.exportActions}>
        <button
          className={styles.exportPrimary}
          type="button"
          disabled={activeMode !== null}
          onClick={() => void download("package")}
        >
          {activeMode === "package"
            ? message(locale, "exportPackageBusy")
            : message(locale, "exportPackageAction")}
        </button>
        <button
          className={styles.exportSecondary}
          type="button"
          disabled={activeMode !== null}
          onClick={() => void download("photos")}
        >
          {activeMode === "photos"
            ? message(locale, "exportPhotosBusy")
            : message(locale, "exportPhotosAction")}
        </button>
      </div>
      <p className={styles.exportStatus} aria-live="polite" aria-atomic="true">
        {busyText}
      </p>
    </section>
  );
}
