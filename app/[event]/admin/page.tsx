"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { TEMPLATES } from "../../templates";
import type { ConfigRevision, PublicEventConfig } from "../../event-config";
import { isPresetId, parseEventPreset, type EventPreset } from "../../event-preset";
import {
  isSupportedLocale,
  message,
  type SupportedLocale,
} from "../../i18n/catalog";
import {
  deviceLocaleStorageKey,
  DocumentLocaleLease,
  resolveEnabledLocales,
  resolveDeviceLocale,
} from "../../i18n/locale";
import type { ModerationPhoto } from "../../moderation";
import type { AdminBoothRecord, BoothOperationalState } from "../../booth-control";
import {
  BoothKeyControls,
  CaptureExperienceControls,
  FrameProgrammeControls,
  SaveConfigurationButton,
} from "./admin-config-controls";
import {
  BoothOperationsCoordinator,
  boothOperationalStateInput,
  mergeBoothPages,
  parseAdminBoothPage,
  parseBoothOperationalStateResponse,
} from "./booth-operations";
import { BoothOperationsPanel } from "./booth-operations-panel";
import { ConfigHistoryPanel } from "./config-history-panel";
import { ExportPanel } from "./export-panel";
import { ModerationDialog } from "./moderation-dialog";
import {
  ModerationPanel,
  type ModerationRebuildState,
} from "./moderation-panel";
import {
  mergeModerationPage,
  moderationFilterInstant,
  ModerationPageCoordinator,
  parseModerationPageResponse,
  removeModeratedPhoto,
  type ModerationFilters,
} from "./moderation-state";
import { PresetPanel } from "./preset-panel";
import {
  buildConfigSaveBody,
  clearRestoreRequestAfterReconciliation,
  editableExperienceFromConfig,
  getOrCreateRestoreRequest,
  parseConfigHistoryResponse,
  parseConfigMutationResponse,
  parsePresetApplyResponse,
  rebaseConfigHistory,
  shouldClearRestoreRequest,
  type RestoreRequest,
} from "./config-mutation";
import {
  buildPresetSaveBody,
  clearPresetApplyAfterReconciliation,
  getOrCreatePresetApply,
  mergePresetPage,
  parsePresetPageResponse,
  reconcileAppliedPreset,
  shouldClearPresetApply,
  type PendingPresetApply,
} from "./preset-state";
import styles from "./admin.module.css";

type AuthState = "missing" | "ready" | "invalid";
type Probe = { status: "up" | "degraded" | "down"; detail: string };
type Health = { upload: Probe; live: Probe };
const CONFIG_CONFLICT_MESSAGE = "Configuration changed; review the latest version before saving.";

export default function Admin() {
  const { event } = useParams<{ event: string }>();
  const [adminKey, setAdminKey] = useState("");
  const [auth, setAuth] = useState<AuthState>("missing");
  const [frames, setFrames] = useState<Set<string>>(new Set());
  const [locales, setLocales] = useState<Set<SupportedLocale>>(new Set(["en"]));
  const [defaultLocale, setDefaultLocale] = useState<SupportedLocale>("en");
  const [uiLocale, setUiLocale] = useState<SupportedLocale>("en");
  const [timeZone, setTimeZone] = useState<string | undefined>();
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [autoAcceptSeconds, setAutoAcceptSeconds] = useState(5);
  const [countdownAudioDefault, setCountdownAudioDefault] = useState(false);
  const [gallery, setGallery] = useState<PublicEventConfig["gallery"]>();
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState("");
  const [currentRevisionId, setCurrentRevisionId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ConfigRevision[]>([]);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);
  const [hasBoothKey, setHasBoothKey] = useState(false);
  const [boothKey, setBoothKey] = useState("");
  const [boothKeySaved, setBoothKeySaved] = useState(false);
  const [photos, setPhotos] = useState<ModerationPhoto[]>([]);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [photosError, setPhotosError] = useState("");
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosLoadingMore, setPhotosLoadingMore] = useState(false);
  const [photoCursor, setPhotoCursor] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<ModerationFilters>({ from: "", to: "" });
  const [appliedFilters, setAppliedFilters] = useState<ModerationFilters>({ from: "", to: "" });
  const [moderationNotice, setModerationNotice] = useState("");
  const [moderationRebuild, setModerationRebuild] = useState<ModerationRebuildState | null>(null);
  const [rebuildingModeration, setRebuildingModeration] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<ModerationPhoto | null>(null);
  const [dialogTrigger, setDialogTrigger] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState<EventPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetIdDraft, setPresetIdDraft] = useState("");
  const [presetLabelDraft, setPresetLabelDraft] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null);
  const [confirmingPresetId, setConfirmingPresetId] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState("");
  const [presetActionError, setPresetActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");
  const [boothQr, setBoothQr] = useState("");
  const [liveQr, setLiveQr] = useState("");
  const [copied, setCopied] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [boothRecords, setBoothRecords] = useState<AdminBoothRecord[]>([]);
  const [boothCursor, setBoothCursor] = useState<string | null>(null);
  const [boothOperationalState, setBoothOperationalState] = useState<BoothOperationalState | null>(null);
  const [boothStatusLoading, setBoothStatusLoading] = useState(false);
  const [boothLoadingMore, setBoothLoadingMore] = useState(false);
  const [boothMutationBusy, setBoothMutationBusy] = useState(false);
  const [boothStatusError, setBoothStatusError] = useState(false);
  const [boothMessageDraft, setBoothMessageDraft] = useState("");
  const moderationCoordinator = useRef(new ModerationPageCoordinator());
  const moderationHeading = useRef<HTMLHeadingElement>(null);
  const moderationPhotoRefs = useRef(new Map<string, HTMLButtonElement>());
  const documentLocale = useRef<DocumentLocaleLease | null>(null);
  const boothCoordinator = useRef(new BoothOperationsCoordinator());
  const boothMessageEditing = useRef(false);
  const configMutationBusy = useRef(false);
  const pendingSaveMutationId = useRef<string | null>(null);
  const pendingRestoreRequests = useRef(new Map<string, RestoreRequest>());
  const pendingPresetApplies = useRef(new Map<string, PendingPresetApply>());

  const boothUrl = `${origin}/${event}`;
  const liveUrl = `${boothUrl}/live`;
  const defaults = useMemo(() => Object.keys(TEMPLATES).filter((key) => !TEMPLATES[key].group), []);
  const configBusy =
    saving
    || restoringRevisionId !== null
    || presetSaving
    || applyingPresetId !== null;
  const currentExperience = useMemo(() => ({
    frames: [...frames],
    locales: [...locales],
    defaultLocale,
    ...(timeZone ? { timeZone } : {}),
    capture: {
      reviewEnabled,
      autoAcceptSeconds,
      countdownAudioDefault,
    },
    ...(gallery ? { gallery: { ...gallery } } : {}),
  }), [
    autoAcceptSeconds,
    countdownAudioDefault,
    defaultLocale,
    frames,
    gallery,
    locales,
    reviewEnabled,
    timeZone,
  ]);
  const clearPendingSave = () => {
    pendingSaveMutationId.current = null;
    setError((current) => current === CONFIG_CONFLICT_MESSAGE ? "" : current);
  };

  const invalidateAuth = () => {
    sessionStorage.removeItem("adminKey");
    setAuth("invalid");
  };

  const runHealth = useCallback(async (key = adminKey) => {
    setCheckingHealth(true); setError("");
    try {
      const response = await fetch("/api/health", { cache: "no-store", headers: { "x-booth-key": key } });
      if (response.status === 401) {
        sessionStorage.removeItem("adminKey");
        setAuth("invalid");
        throw new Error("That admin key was rejected.");
      }
      if (!response.ok) throw new Error(`Readiness checks failed (${response.status})`);
      setHealth(await response.json() as Health);
      setAuth("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Readiness checks could not run");
    } finally { setCheckingHealth(false); }
  }, [adminKey]);

  useEffect(() => {
    setOrigin(window.location.origin);
    documentLocale.current = new DocumentLocaleLease(document.documentElement);
    const stored = sessionStorage.getItem("adminKey") || "";
    if (stored) {
      setAdminKey(stored);
      setAuth("ready");
    }
    return () => {
      documentLocale.current?.restore();
      documentLocale.current = null;
    };
  }, []);

  useEffect(() => {
    documentLocale.current?.apply(event, uiLocale);
  }, [event, uiLocale]);

  useEffect(() => {
    if (!origin) return;
    void QRCode.toDataURL(boothUrl, { width: 240, margin: 1 }).then(setBoothQr).catch(() => setBoothQr(""));
    void QRCode.toDataURL(liveUrl, { width: 240, margin: 1 }).then(setLiveQr).catch(() => setLiveQr(""));
  }, [boothUrl, liveUrl, origin]);

  const fetchConfigHistory = useCallback(async () => {
    const response = await fetch(`/api/config/revisions?event=${encodeURIComponent(event)}`, {
        cache: "no-store",
        headers: { "x-booth-key": adminKey },
    });
    if (response.status === 401) {
      sessionStorage.removeItem("adminKey");
      setAuth("invalid");
      throw new Error("That admin key was rejected.");
    }
    if (!response.ok) throw new Error(`Configuration history returned ${response.status}`);
    const data = parseConfigHistoryResponse(await response.json());
    if (!data) throw new Error("Configuration history had an unexpected shape");
    return data;
  }, [adminKey, event]);

  const loadConfig = useCallback(async () => {
    setConfigLoaded(false);
    setConfigError("");
    try {
      const data = await fetchConfigHistory();
      const rebased = rebaseConfigHistory(data, defaults, pendingSaveMutationId);
      setFrames(new Set(rebased.frames));
      setLocales(new Set(rebased.locales));
      setDefaultLocale(rebased.defaultLocale);
      setUiLocale(resolveDeviceLocale({
        event,
        configured: rebased.locales,
        defaultLocale: rebased.defaultLocale,
        storedLocale: localStorage.getItem(deviceLocaleStorageKey(event)),
        navigatorLanguages: navigator.languages,
      }));
      setTimeZone(rebased.timeZone);
      setReviewEnabled(rebased.reviewEnabled);
      setAutoAcceptSeconds(rebased.autoAcceptSeconds);
      setCountdownAudioDefault(rebased.countdownAudioDefault);
      setGallery(rebased.gallery);
      setHasBoothKey(rebased.hasBoothKey);
      setCurrentRevisionId(rebased.currentRevisionId);
      setRevisions(rebased.revisions);
      setConfigLoaded(true);
      return data;
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : "Config could not be loaded");
      return null;
    }
  }, [defaults, fetchConfigHistory]);

  const loadPresets = useCallback(async () => {
    setPresetsLoading(true);
    setPresetsError("");
    try {
      let cursor: string | null = null;
      let merged: EventPreset[] = [];
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor !== null) query.set("cursor", cursor);
        const response = await fetch(`/api/presets?${query}`, {
          cache: "no-store",
          headers: { "x-booth-key": adminKey },
        });
        if (response.status === 401) {
          invalidateAuth();
          throw new Error("That admin key was rejected.");
        }
        if (!response.ok) throw new Error(`Presets returned ${response.status}`);
        const page = parsePresetPageResponse(await response.json());
        if (!page) throw new Error("Presets had an unexpected shape");
        merged = mergePresetPage(merged, page.presets);
        cursor = page.cursor;
        if (cursor !== null) {
          if (seen.has(cursor)) throw new Error("Presets returned a repeated cursor");
          seen.add(cursor);
        }
      } while (cursor !== null);
      setPresets(merged);
      setPresetsError("");
      return merged;
    } catch (cause) {
      setPresetsError(
        cause instanceof Error ? cause.message : "Presets could not be loaded",
      );
      return null;
    } finally {
      setPresetsLoading(false);
    }
  }, [adminKey, event]);

  const requestModerationPage = useCallback(async (input: {
    reset: boolean;
    filters: ModerationFilters;
    cursor: string | null;
    current: readonly ModerationPhoto[];
  }) => {
    const ticket = moderationCoordinator.current.begin(event, adminKey, input.filters);
    input.reset ? setPhotosLoading(true) : setPhotosLoadingMore(true);
    setPhotosError("");
    setModerationNotice("");
    if (input.reset) {
      setPhotos([]);
      setPhotoCursor(null);
      setPhotosLoaded(false);
      setSelectedPhoto(null);
      setConfirmDelete(false);
      setCleanupPending(false);
    }
    try {
      const from = moderationFilterInstant(input.filters.from);
      const to = moderationFilterInstant(input.filters.to);
      if (
        from === undefined
        || to === undefined
        || (from !== null && to !== null && Date.parse(from) > Date.parse(to))
      ) {
        throw new Error("Choose a valid time range.");
      }
      const query = new URLSearchParams({ event });
      if (!input.reset && input.cursor) query.set("cursor", input.cursor);
      if (from !== null) query.set("from", from);
      if (to !== null) query.set("to", to);
      const response = await fetch(`/api/moderation/photos?${query}`, {
        cache: "no-store",
        headers: { "x-booth-key": adminKey },
      });
      if (!moderationCoordinator.current.accepts(ticket)) return;
      if (response.status === 401) {
        invalidateAuth();
        return;
      }
      if (!response.ok) throw new Error(`Moderation returned ${response.status}`);
      const page = parseModerationPageResponse(await response.json());
      if (!moderationCoordinator.current.accepts(ticket)) return;
      if (!page) throw new Error("Moderation response had an unexpected shape");
      setPhotos(input.reset
        ? mergeModerationPage([], page.photos)
        : mergeModerationPage(input.current, page.photos));
      setPhotoCursor(page.nextCursor);
      setPhotosLoaded(true);
    } catch (cause) {
      if (!moderationCoordinator.current.accepts(ticket)) return;
      setPhotosError(cause instanceof Error
        ? cause.message
        : message(uiLocale, "moderationError"));
    } finally {
      if (moderationCoordinator.current.accepts(ticket)) {
        input.reset ? setPhotosLoading(false) : setPhotosLoadingMore(false);
      }
    }
  }, [adminKey, event, uiLocale]);

  const loadBoothStatus = useCallback(async () => {
    const coordinator = boothCoordinator.current;
    const ticket = coordinator.beginRead(event, adminKey);
    if (!ticket) return;
    setBoothStatusLoading(true);
    setBoothStatusError(false);
    try {
      const stateUrl = `/api/booth-state?event=${encodeURIComponent(event)}`;
      const devicesUrl = `/api/booths?event=${encodeURIComponent(event)}`;
      const headers = { "x-booth-key": adminKey };
      const [stateResult, devicesResult] = await Promise.allSettled([
        fetch(stateUrl, { cache: "no-store", headers, signal: ticket.signal }),
        fetch(devicesUrl, { cache: "no-store", headers, signal: ticket.signal }),
      ]);
      if (!coordinator.isReadCurrent(ticket)) return;

      let failed = false;
      if (stateResult.status === "rejected") {
        failed = true;
      } else if (stateResult.value.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      } else if (!stateResult.value.ok) {
        failed = true;
      } else {
        let nextState: BoothOperationalState | null = null;
        try {
          nextState = parseBoothOperationalStateResponse(await stateResult.value.json());
        } catch {
          // Invalid JSON is handled through the same fixed panel error.
        }
        if (!coordinator.isReadCurrent(ticket)) return;
        if (!nextState) {
          failed = true;
        } else {
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothOperationalState(nextState);
          if (!coordinator.isReadCurrent(ticket)) return;
          if (!boothMessageEditing.current) {
            setBoothMessageDraft(nextState.messages?.en ?? "");
          }
        }
      }

      if (devicesResult.status === "rejected") {
        failed = true;
      } else if (devicesResult.value.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      } else if (!devicesResult.value.ok) {
        failed = true;
      } else {
        let page = null;
        try {
          page = parseAdminBoothPage(await devicesResult.value.json());
        } catch {
          // Invalid JSON is handled through the same fixed panel error.
        }
        if (!coordinator.isReadCurrent(ticket)) return;
        if (!page) {
          failed = true;
        } else {
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothRecords((current) => mergeBoothPages(current, page.booths));
          const tailCursor = coordinator.acceptFirstPage(ticket, page.cursor);
          if (!coordinator.isReadCurrent(ticket)) return;
          setBoothCursor(tailCursor);
        }
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothStatusError(failed);
    } catch {
      if (coordinator.isReadCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishRead(ticket)) setBoothStatusLoading(false);
    }
  }, [adminKey, event]);

  const loadMoreBooths = useCallback(async () => {
    const coordinator = boothCoordinator.current;
    const cursor = coordinator.tailCursor();
    if (cursor === null) return;
    const ticket = coordinator.beginRead(event, adminKey);
    if (!ticket) return;
    setBoothLoadingMore(true);
    setBoothStatusError(false);
    try {
      const query = new URLSearchParams({ event, cursor });
      const response = await fetch(`/api/booths?${query}`, {
        cache: "no-store",
        headers: { "x-booth-key": adminKey },
        signal: ticket.signal,
      });
      if (!coordinator.isReadCurrent(ticket)) return;
      if (response.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      }
      if (!response.ok) {
        if (!coordinator.isReadCurrent(ticket)) return;
        setBoothStatusError(true);
        return;
      }
      let page = null;
      try {
        page = parseAdminBoothPage(await response.json());
      } catch {
        // Invalid JSON is handled through the same fixed panel error.
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      if (!page) {
        setBoothStatusError(true);
        return;
      }
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothRecords((current) => mergeBoothPages(current, page.booths));
      const tailCursor = coordinator.advanceTail(ticket, page.cursor);
      if (!coordinator.isReadCurrent(ticket)) return;
      setBoothCursor(tailCursor);
    } catch {
      if (coordinator.isReadCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishRead(ticket)) setBoothLoadingMore(false);
    }
  }, [adminKey, event]);

  const updateBoothOperationalState = useCallback(async (paused: boolean) => {
    if (!boothOperationalState) return;
    const coordinator = boothCoordinator.current;
    const mutation = coordinator.beginMutation(event, adminKey);
    if (!mutation) return;
    const { ticket, abortedRead } = mutation;
    if (abortedRead) {
      setBoothStatusLoading(false);
      setBoothLoadingMore(false);
    }
    setBoothMutationBusy(true);
    setBoothStatusError(false);
    try {
      const response = await fetch(`/api/booth-state?event=${encodeURIComponent(event)}`, {
        method: "PUT",
        cache: "no-store",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        signal: ticket.signal,
        body: JSON.stringify(boothOperationalStateInput(
          boothOperationalState.messages,
          boothMessageDraft,
          paused
        )),
      });
      if (!coordinator.isMutationCurrent(ticket)) return;
      if (response.status === 401) {
        coordinator.disposeScope();
        invalidateAuth();
        return;
      }
      if (!response.ok) {
        if (!coordinator.isMutationCurrent(ticket)) return;
        setBoothStatusError(true);
        return;
      }
      let nextState: BoothOperationalState | null = null;
      try {
        nextState = parseBoothOperationalStateResponse(await response.json());
      } catch {
        // Invalid JSON is handled through the same fixed panel error.
      }
      if (!coordinator.isMutationCurrent(ticket)) return;
      if (!nextState) {
        setBoothStatusError(true);
        return;
      }
      if (!coordinator.isMutationCurrent(ticket)) return;
      setBoothOperationalState(nextState);
      if (!coordinator.isMutationCurrent(ticket)) return;
      boothMessageEditing.current = false;
      if (!coordinator.isMutationCurrent(ticket)) return;
      setBoothMessageDraft(nextState.messages?.en ?? "");
    } catch {
      if (coordinator.isMutationCurrent(ticket)) setBoothStatusError(true);
    } finally {
      if (coordinator.finishMutation(ticket)) setBoothMutationBusy(false);
    }
  }, [adminKey, boothMessageDraft, boothOperationalState, event]);

  useEffect(() => {
    moderationCoordinator.current.reset();
    if (auth !== "ready" || !adminKey) {
      setPhotos([]);
      setPhotoCursor(null);
      setPhotosLoaded(false);
      return;
    }
    void requestModerationPage({
      reset: true,
      filters: appliedFilters,
      cursor: null,
      current: [],
    });
    return () => moderationCoordinator.current.reset();
  }, [adminKey, appliedFilters, auth, event, requestModerationPage]);

  useEffect(() => {
    if (auth !== "ready" || !adminKey) return;
    void loadConfig();
  }, [adminKey, auth, loadConfig]);

  useEffect(() => {
    if (auth !== "ready" || !adminKey) return;
    void loadPresets();
  }, [adminKey, auth, loadPresets]);

  useEffect(() => {
    const coordinator = boothCoordinator.current;
    if (auth !== "ready" || !adminKey) {
      coordinator.disposeScope();
      return;
    }
    coordinator.activateScope(event, adminKey);
    boothMessageEditing.current = false;
    setBoothRecords([]);
    setBoothCursor(null);
    setBoothOperationalState(null);
    setBoothMessageDraft("");
    setBoothStatusLoading(false);
    setBoothLoadingMore(false);
    setBoothMutationBusy(false);
    setBoothStatusError(false);
    let cancelled = false;
    let nextPoll: number | undefined;
    const poll = async () => {
      await loadBoothStatus();
      if (!cancelled) nextPoll = window.setTimeout(() => void poll(), 15_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
      coordinator.disposeScope();
    };
  }, [adminKey, auth, event, loadBoothStatus]);

  const authenticate = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const next = adminKey.trim();
    if (!next) return;
    sessionStorage.setItem("adminKey", next);
    setAdminKey(next);
    setAuth("ready");
    setError("");
    void runHealth(next);
  };

  const toggle = (key: string) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setFrames((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setNotice("");
  };

  const setGroup = (group: string, enabled: boolean) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    const keys = Object.keys(TEMPLATES).filter((key) => TEMPLATES[key].group === group);
    setFrames((current) => {
      const next = new Set(current);
      keys.forEach((key) => enabled ? next.add(key) : next.delete(key));
      return next;
    });
  };

  const toggleLocale = (locale: SupportedLocale) => {
    if (configMutationBusy.current || locale === "en") return;
    clearPendingSave();
    setLocales((current) => {
      const next = new Set(current);
      if (next.has(locale)) {
        if (next.size === 1) return current;
        next.delete(locale);
        if (defaultLocale === locale) {
          setDefaultLocale(next.values().next().value ?? "en");
        }
      } else {
        next.add(locale);
      }
      return next;
    });
    setNotice("");
  };

  const changeDefaultLocale = (locale: SupportedLocale) => {
    if (configMutationBusy.current || !locales.has(locale)) return;
    clearPendingSave();
    setDefaultLocale(locale);
    setNotice("");
  };

  const changeReviewEnabled = (enabled: boolean) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setReviewEnabled(enabled);
    setNotice("");
  };

  const changeAutoAcceptSeconds = (seconds: number) => {
    if (configMutationBusy.current || !Number.isFinite(seconds)) return;
    clearPendingSave();
    setAutoAcceptSeconds(Math.min(30, Math.max(1, Math.round(seconds))));
    setNotice("");
  };

  const changeCountdownAudioDefault = (enabled: boolean) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setCountdownAudioDefault(enabled);
    setNotice("");
  };

  const generateBoothKey = () => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    setBoothKey(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    setBoothKeySaved(false);
    setNotice("New key generated. Copy it now, then save the event.");
  };

  const changeBoothKey = (value: string) => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setBoothKey(value);
    setBoothKeySaved(false);
  };

  const clearBoothKey = () => {
    if (configMutationBusy.current) return;
    clearPendingSave();
    setBoothKey("");
    setBoothKeySaved(false);
    setCopied("");
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? "" : current), 1800);
    } catch {
      setError("Clipboard access was blocked. Select and copy the value manually.");
    }
  };

  const save = async () => {
    if (!configLoaded || configMutationBusy.current) return;
    if (boothKey && boothKey.length < 12) {
      setError("Booth keys need at least 12 characters.");
      return;
    }
    configMutationBusy.current = true;
    setSaving(true); setError(""); setNotice("");
    const mutationId = pendingSaveMutationId.current ?? crypto.randomUUID();
    pendingSaveMutationId.current = mutationId;
    try {
      const response = await fetch(`/api/config?event=${encodeURIComponent(event)}`, {
        method: "PUT",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify(buildConfigSaveBody({
          frames: [...frames],
          locales: [...locales],
          defaultLocale,
          ...(timeZone ? { timeZone } : {}),
          reviewEnabled,
          autoAcceptSeconds,
          countdownAudioDefault,
          ...(gallery ? { gallery } : {}),
          ...(boothKey ? { boothKey } : {}),
          mutationId,
          baseRevisionId: currentRevisionId,
        })),
      });
      if ([400, 401, 409].includes(response.status)) pendingSaveMutationId.current = null;
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (response.status === 409) {
        await loadConfig();
        setError(CONFIG_CONFLICT_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = parseConfigMutationResponse(await response.json());
      if (!data) throw new Error("Configuration response had an unexpected shape");
      pendingSaveMutationId.current = null;
      setCurrentRevisionId(data.currentRevisionId);
      if (boothKey) { setHasBoothKey(true); setBoothKeySaved(true); }
      await loadConfig();
      setNotice(boothKey ? "Event saved. Keep the new booth key somewhere secure." : "Event configuration saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Event could not be saved");
    } finally {
      configMutationBusy.current = false;
      setSaving(false);
    }
  };

  const restoreRevision = async (revisionId: string) => {
    if (!configLoaded || configMutationBusy.current) return;
    configMutationBusy.current = true;
    const pending = pendingRestoreRequests.current;
    const request = getOrCreateRestoreRequest(
      pending,
      revisionId,
      currentRevisionId,
      () => crypto.randomUUID()
    );
    setRestoringRevisionId(revisionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/config/revisions/restore?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: { "x-booth-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (shouldClearRestoreRequest(response.status)) pending.delete(revisionId);
      if (response.status === 401) { invalidateAuth(); throw new Error("That admin key was rejected."); }
      if (response.status === 409) {
        await loadConfig();
        setError(CONFIG_CONFLICT_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(`Restore failed (${response.status})`);
      await clearRestoreRequestAfterReconciliation(pending, request, async () => {
        const data = parseConfigMutationResponse(await response.json());
        if (!data) throw new Error("Configuration response had an unexpected shape");
        const restored = editableExperienceFromConfig(data, defaults);
        setFrames(new Set(restored.frames));
        setLocales(new Set(restored.locales));
        setDefaultLocale(restored.defaultLocale);
        setTimeZone(restored.timeZone);
        setReviewEnabled(restored.reviewEnabled);
        setAutoAcceptSeconds(restored.autoAcceptSeconds);
        setCountdownAudioDefault(restored.countdownAudioDefault);
        setGallery(restored.gallery);
        setHasBoothKey(Boolean(data.hasBoothKey));
        setCurrentRevisionId(data.currentRevisionId);
        setBoothKey("");
        setBoothKeySaved(false);
        setCopied((current) => current === "key" ? "" : current);
        if (!await loadConfig()) {
          throw new Error("Configuration restored, but history could not be reloaded.");
        }
      });
      setNotice("Configuration restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration could not be restored");
    } finally {
      configMutationBusy.current = false;
      setRestoringRevisionId(null);
    }
  };

  const selectPreset = (presetId: string | null) => {
    if (configMutationBusy.current) return;
    setSelectedPresetId(presetId);
    setConfirmingPresetId(null);
    setPresetActionError("");
    setPresetNotice("");
    const selected = presets.find((preset) => preset.id === presetId);
    setPresetIdDraft(selected?.id ?? "");
    setPresetLabelDraft(selected?.label ?? "");
  };

  const savePreset = async () => {
    if (!configLoaded || configMutationBusy.current) return;
    const presetId = presetIdDraft.trim();
    const label = presetLabelDraft.trim();
    if (!isPresetId(presetId) || !label) {
      setPresetActionError(message(defaultLocale, "presetGenericError"));
      return;
    }
    const selected = presets.find((preset) => preset.id === selectedPresetId);
    configMutationBusy.current = true;
    setPresetSaving(true);
    setPresetActionError("");
    setPresetNotice("");
    try {
      const response = await fetch(
        `/api/presets/${encodeURIComponent(presetId)}`,
        {
          method: "PUT",
          cache: "no-store",
          headers: {
            "x-booth-key": adminKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildPresetSaveBody({
            label,
            expectedUpdatedAt: selected?.updatedAt ?? null,
            experience: currentExperience,
          })),
        },
      );
      if (response.status === 401) {
        invalidateAuth();
        throw new Error("That admin key was rejected.");
      }
      if (response.status === 409) {
        const latest = await loadPresets();
        const refreshed = latest?.find((preset) => preset.id === presetId);
        setSelectedPresetId(refreshed?.id ?? null);
        setPresetIdDraft(refreshed?.id ?? "");
        setPresetLabelDraft(refreshed?.label ?? "");
        setPresetActionError(message(defaultLocale, "presetConflict"));
        return;
      }
      if (!response.ok) throw new Error(`Preset save failed (${response.status})`);
      const saved = parseEventPreset(await response.json());
      if (!saved) throw new Error("Preset response had an unexpected shape");
      setPresets((current) => mergePresetPage(current, [saved]));
      setSelectedPresetId(saved.id);
      setPresetIdDraft(saved.id);
      setPresetLabelDraft(saved.label);
      setPresetNotice(message(defaultLocale, "presetSaved", { preset: saved.label }));
    } catch (cause) {
      setPresetActionError(
        cause instanceof Error
          ? cause.message
          : message(defaultLocale, "presetGenericError"),
      );
    } finally {
      configMutationBusy.current = false;
      setPresetSaving(false);
    }
  };

  const applyPreset = async (presetId: string) => {
    if (!configLoaded || configMutationBusy.current) return;
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    configMutationBusy.current = true;
    const pending = pendingPresetApplies.current;
    const request = getOrCreatePresetApply(
      pending,
      presetId,
      currentRevisionId,
      () => crypto.randomUUID(),
    );
    setApplyingPresetId(presetId);
    setPresetActionError("");
    setPresetNotice("");
    try {
      const response = await fetch(
        `/api/presets/apply?event=${encodeURIComponent(event)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            "x-booth-key": adminKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );
      if (shouldClearPresetApply(response.status)) pending.delete(presetId);
      if (response.status === 401) {
        invalidateAuth();
        throw new Error("That admin key was rejected.");
      }
      if (response.status === 409) {
        await Promise.all([loadConfig(), loadPresets()]);
        setConfirmingPresetId(null);
        setPresetActionError(message(defaultLocale, "presetConflict"));
        return;
      }
      if (!response.ok) throw new Error(`Preset apply failed (${response.status})`);
      await clearPresetApplyAfterReconciliation(pending, request, async () => {
        const applied = parsePresetApplyResponse(await response.json());
        if (!applied) throw new Error("Preset response had an unexpected shape");
        const history = await fetchConfigHistory();
        const rebased = reconcileAppliedPreset({
          response: applied,
          history,
          sourcePresetId: presetId,
        });
        setFrames(new Set(rebased.experience.frames));
        const appliedLocales = resolveEnabledLocales(rebased.experience.locales);
        setLocales(new Set(appliedLocales));
        setDefaultLocale(
          isSupportedLocale(rebased.experience.defaultLocale)
          && appliedLocales.includes(rebased.experience.defaultLocale)
            ? rebased.experience.defaultLocale
            : "en",
        );
        setTimeZone(rebased.experience.timeZone);
        setReviewEnabled(rebased.experience.capture?.reviewEnabled ?? true);
        setAutoAcceptSeconds(rebased.experience.capture?.autoAcceptSeconds ?? 5);
        setCountdownAudioDefault(
          rebased.experience.capture?.countdownAudioDefault ?? false,
        );
        setGallery(rebased.experience.gallery);
        setCurrentRevisionId(rebased.currentRevisionId);
        setRevisions(history.revisions);
        setHasBoothKey(rebased.hasBoothKey);
        pendingSaveMutationId.current = null;
        setConfigError("");
        setConfigLoaded(true);
        setBoothKey("");
        setBoothKeySaved(false);
        setCopied((current) => current === "key" ? "" : current);
      });
      setConfirmingPresetId(null);
      setPresetNotice(message(defaultLocale, "presetApplied", {
        preset: preset.label,
      }));
    } catch (cause) {
      setPresetActionError(
        cause instanceof Error
          ? cause.message
          : message(defaultLocale, "presetGenericError"),
      );
    } finally {
      configMutationBusy.current = false;
      setApplyingPresetId(null);
    }
  };

  const deletePhoto = async (photo: ModerationPhoto) => {
    setDeleting(true);
    setPhotosError("");
    try {
      const response = await fetch(`/api/photos?event=${encodeURIComponent(event)}&key=${encodeURIComponent(photo.key)}`, {
        method: "DELETE", headers: { "x-booth-key": adminKey },
      });
      if (response.status === 401) {
        invalidateAuth();
        return;
      }
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      const value: unknown = await response.json();
      if (
        !value
        || typeof value !== "object"
        || (value as { deleted?: unknown }).deleted !== true
        || (value as { key?: unknown }).key !== photo.key
        || typeof (value as { cleanupPending?: unknown }).cleanupPending !== "boolean"
      ) {
        throw new Error("Delete response had an unexpected shape");
      }
      const pending = (value as { cleanupPending: boolean }).cleanupPending;
      const removal = removeModeratedPhoto(photos, photo.key);
      setPhotos(removal.photos);
      setConfirmDelete(false);
      setModerationNotice(message(uiLocale, "moderationDeleted"));
      setCleanupPending(pending);
      setDialogTrigger(null);
      if (!pending) setSelectedPhoto(null);
      window.setTimeout(() => {
        if (removal.nextFocusKey) {
          moderationPhotoRefs.current.get(removal.nextFocusKey)?.focus();
        } else {
          moderationHeading.current?.focus();
        }
      }, 0);
    } catch (cause) {
      setPhotosError(cause instanceof Error
        ? cause.message
        : message(uiLocale, "moderationDeleteError"));
    } finally {
      setDeleting(false);
    }
  };

  const rebuildModerationIndex = async () => {
    setRebuildingModeration(true);
    setPhotosError("");
    try {
      const response = await fetch(
        `/api/moderation/photos/rebuild?event=${encodeURIComponent(event)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "x-booth-key": adminKey },
        }
      );
      if (response.status === 401) {
        invalidateAuth();
        return;
      }
      if (!response.ok && response.status !== 202) {
        throw new Error(`Index rebuild returned ${response.status}`);
      }
      const value: unknown = await response.json();
      if (
        !value
        || typeof value !== "object"
        || typeof (value as { complete?: unknown }).complete !== "boolean"
        || typeof (value as { scanned?: unknown }).scanned !== "number"
        || typeof (value as { indexed?: unknown }).indexed !== "number"
      ) {
        throw new Error("Index rebuild response had an unexpected shape");
      }
      setModerationRebuild({
        complete: (value as { complete: boolean }).complete,
        scanned: (value as { scanned: number }).scanned,
        indexed: (value as { indexed: number }).indexed,
      });
      await requestModerationPage({
        reset: true,
        filters: appliedFilters,
        cursor: null,
        current: [],
      });
    } catch (cause) {
      setPhotosError(cause instanceof Error
        ? cause.message
        : message(uiLocale, "moderationError"));
    } finally {
      setRebuildingModeration(false);
    }
  };

  const facts: { label: string; value: string; tone: "good" | "bad" | "wait"; detail?: string }[] = [
    { label: "Config", value: configLoaded ? "Loaded" : configError ? "Error" : "Checking", tone: configLoaded ? "good" : configError ? "bad" : "wait" },
    { label: "Frames", value: `${frames.size} enabled`, tone: frames.size > 0 ? "good" : "bad" },
    { label: "Booth key", value: hasBoothKey ? "Installed" : "Missing", tone: hasBoothKey ? "good" : "bad" },
    { label: "Photos", value: photosLoaded ? `${photos.length} loaded` : photosError ? "Error" : "Checking", tone: photosLoaded ? "good" : photosError ? "bad" : "wait" },
    { label: "Upload", value: health ? health.upload.status : "Unchecked", tone: health ? health.upload.status === "up" ? "good" : health.upload.status === "degraded" ? "wait" : "bad" : "wait", detail: health?.upload.detail },
    { label: "Live", value: health ? health.live.status : "Unchecked", tone: health ? health.live.status === "up" ? "good" : health.live.status === "degraded" ? "wait" : "bad" : "wait", detail: health?.live.detail },
  ];
  const selectedIndex = selectedPhoto
    ? photos.findIndex((photo) => photo.key === selectedPhoto.key)
    : -1;

  if (auth !== "ready") {
    return (
      <main className={styles.authPage}>
        <form className={styles.authCard} onSubmit={authenticate}>
          <p className={styles.kicker}>Darkroom access / {event}</p>
          <h1>Operator<br />sign-in</h1>
          <p>{auth === "invalid" ? "That credential was rejected. Enter the admin key again." : "Load the admin credential to operate this event."}</p>
          <label htmlFor="admin-key">Admin key</label>
          <input id="admin-key" type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="current-password" autoFocus />
          <button type="submit" disabled={!adminKey.trim()}>Enter darkroom →</button>
        </form>
      </main>
    );
  }

  return (
    <main className={styles.console}>
      <header className={styles.header}>
        <div><p className={styles.kicker}>Webbooth / operator console</p><h1>{event}</h1><code>/{event}</code></div>
        <div className={styles.headerActions}>
          <a href="/frame-lab">Open frame lab ↗</a>
          <button onClick={() => { sessionStorage.removeItem("adminKey"); setAuth("missing"); setAdminKey(""); }}>Lock console</button>
        </div>
      </header>

      <section className={styles.readiness} aria-label="Event readiness">
        <div className={styles.railLabel}><span>Ready?</span><strong>{facts.every((fact) => fact.tone === "good") ? "YES" : "CHECK"}</strong><button onClick={() => void runHealth()} disabled={checkingHealth}>{checkingHealth ? "Running…" : "Run checks"}</button></div>
        {facts.map((fact, index) => <div className={styles.fact} key={fact.label} title={fact.detail}><span>0{index + 1} / {fact.label}</span><strong data-tone={fact.tone}>{fact.value}</strong></div>)}
      </section>

      {(error || notice) && <div className={error ? styles.errorBanner : styles.noticeBanner} role="status"><span>{error ? "Attention" : "Done"}</span><p>{error || notice}</p><button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.section}>
            <div className={styles.sectionHead}><div><span>01</span><h2>Frame programme</h2></div><p>Choose what guests see at the booth. Previews follow the real background → photo → overlay composition.</p></div>
            {configError ? <div className={styles.failure}><strong>Config unavailable</strong><p>{configError}</p><button onClick={() => void loadConfig()}>Retry config</button></div> : (
              <>
                <FrameProgrammeControls
                  frames={frames}
                  defaults={defaults}
                  disabled={configBusy}
                  onToggle={toggle}
                  onSetGroup={setGroup}
                />
                <div className={styles.experiencePanel}>
                  <div>
                    <span>Guest capture</span>
                    <h3>Language &amp; review</h3>
                    <p>Set the languages guests can choose and the handoff after each exposure.</p>
                  </div>
                  <CaptureExperienceControls
                    enabledLocales={locales}
                    defaultLocale={defaultLocale}
                    reviewEnabled={reviewEnabled}
                    autoAcceptSeconds={autoAcceptSeconds}
                    countdownAudioDefault={countdownAudioDefault}
                    disabled={configBusy}
                    onToggleLocale={toggleLocale}
                    onDefaultLocaleChange={changeDefaultLocale}
                    onReviewEnabledChange={changeReviewEnabled}
                    onAutoAcceptSecondsChange={changeAutoAcceptSeconds}
                    onCountdownAudioDefaultChange={changeCountdownAudioDefault}
                  />
                </div>
              </>
            )}
          </section>

          <ConfigHistoryPanel
            currentFrames={[...frames]}
            currentExperience={currentExperience}
            currentRevisionId={currentRevisionId}
            revisions={revisions}
            loading={!configLoaded && !configError}
            restoringRevisionId={restoringRevisionId}
            mutationBusy={configBusy}
            locale={defaultLocale}
            error={configError}
            onReload={() => void loadConfig()}
            onRestore={(revisionId) => void restoreRevision(revisionId)}
          />

          <PresetPanel
            locale={defaultLocale}
            event={event}
            currentExperience={currentExperience}
            presets={presets}
            selectedPresetId={selectedPresetId}
            presetIdDraft={presetIdDraft}
            presetLabelDraft={presetLabelDraft}
            loading={presetsLoading}
            loadError={presetsError}
            mutationBusy={configBusy || !configLoaded}
            saving={presetSaving}
            applyingPresetId={applyingPresetId}
            confirmingPresetId={confirmingPresetId}
            hasBoothKey={hasBoothKey}
            successMessage={presetNotice}
            errorMessage={presetActionError}
            onPresetIdChange={(value) => {
              setPresetIdDraft(value);
              setPresetActionError("");
            }}
            onPresetLabelChange={(value) => {
              setPresetLabelDraft(value);
              setPresetActionError("");
            }}
            onSelectPreset={selectPreset}
            onSave={() => void savePreset()}
            onRequestApply={(presetId) => {
              setConfirmingPresetId(presetId);
              setPresetActionError("");
              setPresetNotice("");
            }}
            onConfirmApply={(presetId) => void applyPreset(presetId)}
            onCancelApply={() => setConfirmingPresetId(null)}
            onReload={() => void loadPresets()}
          />

          <BoothOperationsPanel
            records={boothRecords}
            cursor={boothCursor}
            operationalState={boothOperationalState}
            loading={boothStatusLoading}
            loadingMore={boothLoadingMore}
            mutationBusy={boothMutationBusy}
            hasError={boothStatusError}
            englishMessageDraft={boothMessageDraft}
            onEnglishMessageChange={(message) => {
              boothMessageEditing.current = true;
              setBoothMessageDraft(message);
            }}
            onRefresh={() => void loadBoothStatus()}
            onLoadMore={() => void loadMoreBooths()}
            onPause={() => void updateBoothOperationalState(true)}
            onResume={() => void updateBoothOperationalState(false)}
          />

          <ModerationPanel
            locale={uiLocale}
            photos={photos}
            filters={draftFilters}
            nextCursor={photoCursor}
            loading={photosLoading}
            loadingMore={photosLoadingMore}
            error={photosError}
            notice={moderationNotice}
            rebuild={moderationRebuild}
            rebuilding={rebuildingModeration}
            timeZone={timeZone}
            headingRef={moderationHeading}
            photoRefs={moderationPhotoRefs}
            onFiltersChange={setDraftFilters}
            onApplyFilters={() => {
              if (
                appliedFilters.from === draftFilters.from
                && appliedFilters.to === draftFilters.to
              ) {
                void requestModerationPage({
                  reset: true,
                  filters: draftFilters,
                  cursor: null,
                  current: [],
                });
              } else {
                setAppliedFilters({ ...draftFilters });
              }
            }}
            onClearFilters={() => {
              const clear = { from: "", to: "" };
              setDraftFilters(clear);
              if (appliedFilters.from || appliedFilters.to) setAppliedFilters(clear);
              else void requestModerationPage({
                reset: true,
                filters: clear,
                cursor: null,
                current: [],
              });
            }}
            onLoadMore={() => void requestModerationPage({
              reset: false,
              filters: appliedFilters,
              cursor: photoCursor,
              current: photos,
            })}
            onOpen={(photo, trigger) => {
              setSelectedPhoto(photo);
              setDialogTrigger(trigger);
              setConfirmDelete(false);
              setCleanupPending(false);
              setPhotosError("");
            }}
            onRebuild={() => void rebuildModerationIndex()}
          />
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.sideCard}>
            <span className={styles.cardNumber}>05</span><h2>Booth credential</h2>
            <p>{hasBoothKey ? "A booth key is installed. Generate a replacement only when rotating iPad access." : "No booth key yet. Generate one before the booth can upload."}</p>
            <BoothKeyControls
              value={boothKey}
              saved={boothKeySaved}
              copied={copied === "key"}
              disabled={configBusy}
              placeholder={hasBoothKey ? "Unchanged" : "Generate a key"}
              onChange={changeBoothKey}
              onGenerate={generateBoothKey}
              onCopy={() => void copy(boothKey, "key")}
              onClear={clearBoothKey}
            />
          </section>

          <LinkCard label="Booth / iPad" url={boothUrl} qr={boothQr} copied={copied === "booth"} copy={() => void copy(boothUrl, "booth")} />
          <LinkCard label="Live / projector" url={liveUrl} qr={liveQr} copied={copied === "live"} copy={() => void copy(liveUrl, "live")} />

          <section className={styles.sideCard}>
            <span className={styles.cardNumber}>06</span><h2>Ship the event</h2>
            <SaveConfigurationButton
              disabled={!configLoaded || configBusy}
              saving={saving}
              onSave={() => void save()}
            />
          </section>
          <ExportPanel
            event={event}
            adminKey={adminKey}
            locale={defaultLocale}
            onUnauthorized={invalidateAuth}
            onNotice={setNotice}
            onError={setError}
          />
        </aside>
      </div>
      {selectedPhoto && (
        <ModerationDialog
          locale={uiLocale}
          photo={selectedPhoto}
          position={selectedIndex >= 0 ? selectedIndex + 1 : 1}
          loadedCount={Math.max(photos.length, 1)}
          hasPrevious={selectedIndex > 0}
          hasNext={selectedIndex >= 0 && selectedIndex < photos.length - 1}
          confirming={confirmDelete}
          deleting={deleting}
          cleanupPending={cleanupPending}
          error={photosError}
          timeZone={timeZone}
          returnFocus={dialogTrigger}
          onPrevious={() => {
            if (selectedIndex > 0) setSelectedPhoto(photos[selectedIndex - 1]);
          }}
          onNext={() => {
            if (selectedIndex >= 0 && selectedIndex < photos.length - 1) {
              setSelectedPhoto(photos[selectedIndex + 1]);
            }
          }}
          onClose={() => {
            setSelectedPhoto(null);
            setConfirmDelete(false);
            setCleanupPending(false);
            setPhotosError("");
          }}
          onRequestDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
          onConfirmDelete={() => void deletePhoto(selectedPhoto)}
        />
      )}
    </main>
  );
}

function LinkCard({ label, url, qr, copied, copy }: { label: string; url: string; qr: string; copied: boolean; copy: () => void }) {
  return <section className={styles.linkCard}>
    <div><span>Event route</span><h2>{label}</h2><code>{url || "Building URL…"}</code><div className={styles.linkActions}><a href={url}>Open ↗</a><button onClick={copy}>{copied ? "Copied ✓" : "Copy URL"}</button></div></div>
    {qr && <img src={qr} alt={`QR code for ${label}`} />}
  </section>;
}
