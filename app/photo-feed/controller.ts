import type {
  FeedPhoto,
  FeedProfile,
  PhotoFeedEffect,
  PhotoFeedEvent,
  PhotoFeedState,
} from "./types";

export const PROJECTOR_FEED_PROFILE: FeedProfile = {
  activeMs: 2_000,
  quietMinMs: 10_000,
  quietMaxMs: 20_000,
  errorBaseMs: 4_000,
  errorMaxMs: 60_000,
};

export const BROWSE_FEED_PROFILE: FeedProfile = {
  activeMs: 3_500,
  quietMinMs: 10_000,
  quietMaxMs: 20_000,
  errorBaseMs: 4_000,
  errorMaxMs: 60_000,
};

export function initialPhotoFeedState(event: string, visible = true): PhotoFeedState {
  return {
    event,
    photos: [],
    cursor: null,
    status: "loading",
    visible,
    request: null,
    refreshPending: false,
    quietCount: 0,
    failureCount: 0,
    error: null,
    generation: 0,
    nextRequestId: 1,
  };
}

export function mergePhotoFeed(
  current: readonly FeedPhoto[],
  incoming: readonly FeedPhoto[],
): { photos: FeedPhoto[]; inserted: FeedPhoto[] } {
  if (incoming.length === 0) return { photos: current as FeedPhoto[], inserted: [] };

  const currentKeys = new Set(current.map((photo) => photo.key));
  const incomingKeys = new Set<string>();
  const uniqueIncoming: FeedPhoto[] = [];
  for (const photo of incoming) {
    if (incomingKeys.has(photo.key)) continue;
    incomingKeys.add(photo.key);
    uniqueIncoming.push(photo);
  }

  const photos = [
    ...uniqueIncoming,
    ...current.filter((photo) => !incomingKeys.has(photo.key)),
  ];
  return {
    photos,
    inserted: uniqueIncoming.filter((photo) => !currentKeys.has(photo.key)),
  };
}

function startRequest(
  state: PhotoFeedState,
): { state: PhotoFeedState; effects: PhotoFeedEffect[] } {
  if (!state.visible || state.request) return { state, effects: [] };
  const id = state.nextRequestId;
  const request = { id, after: state.cursor };
  return {
    state: {
      ...state,
      request,
      nextRequestId: id + 1,
      refreshPending: false,
      status: state.photos.length === 0 ? "loading" : state.status,
    },
    effects: [
      {
        type: "request",
        requestId: id,
        generation: state.generation,
        after: state.cursor,
      },
    ],
  };
}

function matchesRequest(
  state: PhotoFeedState,
  requestId: number,
  generation: number,
): boolean {
  return state.generation === generation && state.request?.id === requestId;
}

function unitRandom(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function quietDelay(profile: FeedProfile, random: number): number {
  const range = Math.max(0, profile.quietMaxMs - profile.quietMinMs);
  return Math.round(profile.quietMinMs + range * unitRandom(random));
}

function errorDelay(profile: FeedProfile, failures: number, random: number): number {
  const exponential = profile.errorBaseMs * 2 ** Math.max(0, failures - 1);
  const jittered = exponential * (0.5 + unitRandom(random) * 0.5);
  return Math.min(profile.errorMaxMs, Math.round(jittered));
}

export function reducePhotoFeed(
  state: PhotoFeedState,
  event: PhotoFeedEvent,
): { state: PhotoFeedState; effects: PhotoFeedEffect[] } {
  switch (event.type) {
    case "start":
    case "timer":
      return startRequest(state);

    case "event-change": {
      if (event.event === state.event) return { state, effects: [] };
      const effects: PhotoFeedEffect[] = [];
      if (state.request) effects.push({ type: "abort", requestId: state.request.id });
      effects.push({ type: "cancel-schedule" });
      const reset: PhotoFeedState = {
        ...initialPhotoFeedState(event.event, state.visible),
        generation: state.generation + 1,
        nextRequestId: state.nextRequestId,
      };
      const started = startRequest(reset);
      return { state: started.state, effects: [...effects, ...started.effects] };
    }

    case "visibility": {
      if (event.visible === state.visible) return { state, effects: [] };
      if (!event.visible) {
        const effects: PhotoFeedEffect[] = [];
        if (state.request) effects.push({ type: "abort", requestId: state.request.id });
        effects.push({ type: "cancel-schedule" });
        return { state: { ...state, visible: false, refreshPending: false }, effects };
      }
      const visible = { ...state, visible: true };
      if (visible.request) return { state: { ...visible, refreshPending: true }, effects: [] };
      return startRequest(visible);
    }

    case "refresh":
      if (state.request) {
        if (state.refreshPending) return { state, effects: [] };
        return {
          state: { ...state, refreshPending: true },
          effects: [{ type: "abort", requestId: state.request.id }],
        };
      }
      return startRequest(state);

    case "request-aborted": {
      if (!matchesRequest(state, event.requestId, event.generation)) {
        return { state, effects: [] };
      }
      const settled = { ...state, request: null };
      if (settled.visible && settled.refreshPending) {
        return startRequest({ ...settled, refreshPending: false });
      }
      return { state: { ...settled, refreshPending: false }, effects: [] };
    }

    case "request-success": {
      if (!matchesRequest(state, event.requestId, event.generation)) {
        return { state, effects: [] };
      }
      const merged = mergePhotoFeed(state.photos, event.photos);
      const quietCount = merged.inserted.length === 0 ? state.quietCount + 1 : 0;
      const next: PhotoFeedState = {
        ...state,
        photos: merged.photos,
        cursor:
          typeof event.cursor === "string" && event.cursor.length > 0
            ? event.cursor
            : state.cursor,
        status: "ready",
        request: null,
        refreshPending: false,
        quietCount,
        failureCount: 0,
        error: null,
      };
      const delayMs =
        merged.inserted.length > 0
          ? event.profile.activeMs
          : quietDelay(event.profile, event.random);
      return {
        state: next,
        effects: next.visible ? [{ type: "schedule", delayMs }] : [],
      };
    }

    case "request-error": {
      if (!matchesRequest(state, event.requestId, event.generation)) {
        return { state, effects: [] };
      }
      const failureCount = state.failureCount + 1;
      const next: PhotoFeedState = {
        ...state,
        status: "error",
        request: null,
        refreshPending: false,
        failureCount,
        error: event.error,
      };
      return {
        state: next,
        effects: next.visible
          ? [{ type: "schedule", delayMs: errorDelay(event.profile, failureCount, event.random) }]
          : [],
      };
    }
  }
}
