"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { initialPhotoFeedState, reducePhotoFeed } from "./controller";
import type {
  FeedPhoto,
  FeedProfile,
  PhotoFeedEffect,
  PhotoFeedEvent,
  PhotoFeedState,
} from "./types";

export type PhotoFeedSnapshot = PhotoFeedState & { inserted: FeedPhoto[] };

export type PhotoFeedRuntimeProviders = {
  fetch(url: string, init: { signal: AbortSignal }): Promise<unknown>;
  random(): number;
  timer: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  visibility: {
    isVisible(): boolean;
    subscribe(listener: () => void): () => void;
  };
};

function parsePhoto(value: unknown): FeedPhoto | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    typeof record.url !== "string" ||
    record.url.length === 0 ||
    typeof record.uploadedAt !== "string" ||
    record.uploadedAt.length === 0 ||
    Number.isNaN(Date.parse(record.uploadedAt))
  ) {
    return null;
  }
  return { key: record.key, url: record.url, uploadedAt: record.uploadedAt };
}

export function parsePhotoFeedResponse(
  value: unknown,
): { photos: FeedPhoto[]; cursor: string | null } {
  if (!value || typeof value !== "object") throw new Error("Invalid photo feed response");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.photos)) throw new Error("Invalid photo feed photos");
  if (record.cursor !== null && (typeof record.cursor !== "string" || record.cursor.length === 0)) {
    throw new Error("Invalid photo feed cursor");
  }
  const photos = record.photos.map(parsePhoto);
  if (photos.some((photo) => photo === null)) throw new Error("Invalid photo feed photo");
  return { photos: photos as FeedPhoto[], cursor: record.cursor as string | null };
}

function browserProviders(): PhotoFeedRuntimeProviders {
  return {
    async fetch(url, init) {
      const response = await fetch(url, { signal: init.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Photo feed request failed (${response.status})`);
      return response.json();
    },
    random: Math.random,
    timer: {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    visibility: {
      isVisible: () => document.visibilityState !== "hidden",
      subscribe(listener) {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    },
  };
}

export class PhotoFeedRuntime {
  private state: PhotoFeedState;
  private currentSnapshot: PhotoFeedSnapshot;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private timer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private started = false;
  private disposed = false;

  constructor(
    event: string,
    private readonly profile: FeedProfile,
    private readonly providers: PhotoFeedRuntimeProviders,
  ) {
    this.state = initialPhotoFeedState(event, providers.visibility.isVisible());
    this.currentSnapshot = { ...this.state, inserted: [] };
  }

  snapshot = (): PhotoFeedSnapshot => this.currentSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribeVisibility = this.providers.visibility.subscribe(() => {
      this.dispatch({
        type: "visibility",
        visible: this.providers.visibility.isVisible(),
      });
    });
    this.dispatch({ type: "start" });
  }

  refresh = (): void => {
    this.dispatch({ type: "refresh" });
  };

  setEvent(event: string): void {
    this.dispatch({ type: "event-change", event });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    this.controller = null;
    this.clearTimer();
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.listeners.clear();
  }

  private dispatch(event: PhotoFeedEvent): void {
    if (this.disposed) return;
    const result = reducePhotoFeed(this.state, event);
    const changed = result.state !== this.state;
    this.state = result.state;
    const inserted =
      event.type === "request-success" && changed
        ? this.state.photos.filter(
            (photo) =>
              event.photos.some((candidate) => candidate.key === photo.key) &&
              !this.currentSnapshot.photos.some((prior) => prior.key === photo.key),
          )
        : [];
    if (changed) {
      this.currentSnapshot = { ...this.state, inserted };
      this.listeners.forEach((listener) => listener());
    }
    result.effects.forEach((effect) => this.execute(effect));
  }

  private execute(effect: PhotoFeedEffect): void {
    if (this.disposed) return;
    switch (effect.type) {
      case "abort":
        this.controller?.abort();
        return;
      case "cancel-schedule":
        this.clearTimer();
        return;
      case "schedule":
        this.clearTimer();
        this.timer = this.providers.timer.setTimeout(() => {
          this.timer = null;
          this.dispatch({ type: "timer" });
        }, effect.delayMs);
        return;
      case "request":
        this.request(effect);
        return;
    }
  }

  private request(
    effect: Extract<PhotoFeedEffect, { type: "request" }>,
  ): void {
    this.clearTimer();
    const controller = new AbortController();
    this.controller = controller;
    const search = new URLSearchParams({ event: this.state.event });
    if (effect.after !== null) search.set("after", effect.after);
    void this.providers
      .fetch(`/api/photos?${search.toString()}`, { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) {
          this.dispatch({
            type: "request-aborted",
            requestId: effect.requestId,
            generation: effect.generation,
          });
          return;
        }
        const response = parsePhotoFeedResponse(raw);
        this.dispatch({
          type: "request-success",
          requestId: effect.requestId,
          generation: effect.generation,
          photos: response.photos,
          cursor: response.cursor,
          profile: this.profile,
          random: this.providers.random(),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          this.dispatch({
            type: "request-aborted",
            requestId: effect.requestId,
            generation: effect.generation,
          });
          return;
        }
        this.dispatch({
          type: "request-error",
          requestId: effect.requestId,
          generation: effect.generation,
          error: error instanceof Error ? error.message : "Photo feed request failed",
          profile: this.profile,
          random: this.providers.random(),
        });
      })
      .finally(() => {
        if (this.controller === controller) this.controller = null;
      });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.providers.timer.clearTimeout(this.timer);
    this.timer = null;
  }
}

export function usePhotoFeed(
  event: string,
  profile: FeedProfile,
  providers?: PhotoFeedRuntimeProviders,
): PhotoFeedSnapshot & { refresh(): void } {
  const runtime = useMemo(
    () => new PhotoFeedRuntime(event, profile, providers ?? browserProviders()),
    [event, profile, providers],
  );
  useEffect(() => {
    runtime.start();
    return () => runtime.dispose();
  }, [runtime]);
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  return { ...snapshot, refresh: runtime.refresh };
}
