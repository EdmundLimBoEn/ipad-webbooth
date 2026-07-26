export type FeedPhoto = {
  key: string;
  url: string;
  uploadedAt: string;
};

export type FeedProfile = {
  activeMs: number;
  quietMinMs: number;
  quietMaxMs: number;
  errorBaseMs: number;
  errorMaxMs: number;
};

export type PhotoFeedState = {
  event: string;
  photos: FeedPhoto[];
  cursor: string | null;
  status: "loading" | "ready" | "error";
  visible: boolean;
  request: { id: number; after: string | null } | null;
  refreshPending: boolean;
  quietCount: number;
  failureCount: number;
  error: string | null;
  generation: number;
  nextRequestId: number;
};

export type PhotoFeedEvent =
  | { type: "start" }
  | { type: "event-change"; event: string }
  | { type: "visibility"; visible: boolean }
  | { type: "refresh" }
  | { type: "timer" }
  | {
      type: "request-success";
      requestId: number;
      generation: number;
      photos: FeedPhoto[];
      cursor: string | null;
      profile: FeedProfile;
      random: number;
    }
  | {
      type: "request-error";
      requestId: number;
      generation: number;
      error: string;
      profile: FeedProfile;
      random: number;
    }
  | { type: "request-aborted"; requestId: number; generation: number };

export type PhotoFeedEffect =
  | { type: "request"; requestId: number; generation: number; after: string | null }
  | { type: "abort"; requestId: number }
  | { type: "schedule"; delayMs: number }
  | { type: "cancel-schedule" };
