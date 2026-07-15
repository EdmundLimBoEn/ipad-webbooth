import { EventStore, HEALTH_CANARY_KEY } from "./event-store";

// Cron health check → statuspage.io components, via the REST API
// (PATCH /v1/pages/{page}/components/{component}). Email automation was the
// first design but sending email from a Worker needs the paid plan; the API
// is free (1 req/s limit vs our 2 per 5 min). Each probe maps to its own
// component: R2 binding → "Upload", public bucket endpoint → "Live page".
// Self-reporting can't catch a dead worker (a broken deploy kills this
// handler too); it covers what fails independently of the worker.

type Status = "up" | "degraded" | "down";
const COMPONENTS = ["upload", "live"] as const;
type Component = (typeof COMPONENTS)[number];
const STATUSPAGE_STATUS: Record<Status, string> = {
  up: "operational",
  degraded: "degraded_performance",
  down: "major_outage",
};

// Workers free tier: 100k requests/day (the gallery alone burns ~1.2k/hr per
// open tab). Report "degraded" at 80% so an event doesn't silently start
// 403ing guests.
const DAILY_REQ_LIMIT = 100_000;
const HEADROOM_RATIO = 0.8;

// Pure transition rule: report only when the status changes. Missing state
// (first run, or R2 unreadable) is treated as "up" so a healthy steady state
// never reports.
export function decide(
  prev: Status | null,
  next: Status
): { report: Status | null; next: Status } {
  return { report: next === (prev ?? "up") ? null : next, next };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Today's (UTC — the free-tier day resets at 00:00 UTC) Workers request count
// across the account, via the GraphQL analytics API. null = check unavailable
// (token unset, API error): a soft signal, never turns into an outage.
async function requestsToday(env: CloudflareEnv): Promise<number | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          "query($account:String!,$date:Date!){viewer{accounts(filter:{accountTag:$account}){workersInvocationsAdaptive(filter:{date:$date},limit:100){sum{requests}}}}}",
        variables: { account: env.CF_ACCOUNT_ID, date: new Date().toISOString().slice(0, 10) },
      }),
    });
    const j = (await res.json()) as {
      data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: { sum?: { requests?: number } }[] }[] } };
    };
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(rows)) return null;
    return rows.reduce((n, r) => n + (r.sum?.requests ?? 0), 0);
  } catch {
    return null;
  }
}

export async function probes(
  env: CloudflareEnv,
  fetcher: Fetcher = fetch
): Promise<Record<Component, { status: Status; detail: string }>> {
  const store = EventStore.fromEnv(env);
  const probeId = crypto.randomUUID();
  const canary = `webbooth-health:${probeId}`;
  // A unique key prevents an operator readiness check and the scheduled probe
  // from overwriting or deleting one another when they overlap.
  const canaryKey = `${HEALTH_CANARY_KEY}/${probeId}.txt`;
  let upload: { status: Status; detail: string } = { status: "up", detail: "ok" };
  try {
    await store.photos.put(canaryKey, canary, {
      httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
    });
    const read = await store.photos.get(canaryKey);
    if (!read || await read.text() !== canary) throw new Error("canary read did not match write");
  } catch (e) {
    upload = { status: "down", detail: `R2 canary write/read: ${e}` };
  }
  if (upload.status === "up") {
    // Request-count headroom lands on the Upload component: the daily cap
    // throttles the Worker (upload + photos APIs), not the public bucket.
    const reqs = await requestsToday(env);
    if (reqs !== null && reqs >= DAILY_REQ_LIMIT * HEADROOM_RATIO) {
      upload = { status: "degraded", detail: `${reqs} requests today ≥ ${HEADROOM_RATIO * 100}% of ${DAILY_REQ_LIMIT}/day` };
    }
  }
  let live: { status: Status; detail: string } = { status: "up", detail: "ok" };
  if (upload.status === "down") {
    live = { status: "down", detail: "public canary unavailable because R2 write/read failed" };
  } else {
    try {
      const url = `${store.publicUrl(canaryKey)}?probe=${encodeURIComponent(canary)}`;
      const res = await fetcher(url, { headers: { "cache-control": "no-cache" } });
      const body = await res.text();
      if (!res.ok || body !== canary) {
        live = { status: "down", detail: `public canary: HTTP ${res.status}, matching body=${body === canary}` };
      }
    } catch (e) {
      live = { status: "down", detail: `public canary: ${e}` };
    }
  }
  try {
    // Delete exactly the canary object, including after a failed read/public probe.
    await store.photos.delete(canaryKey);
  } catch (e) {
    upload = { status: "down", detail: `R2 canary delete: ${e}` };
  }
  return { upload, live };
}

export async function healthCheck(env: CloudflareEnv): Promise<void> {
  const ids: Record<Component, string | undefined> = {
    upload: env.STATUSPAGE_COMPONENT_UPLOAD,
    live: env.STATUSPAGE_COMPONENT_LIVE,
  };
  if (!env.STATUSPAGE_API_KEY || !env.STATUSPAGE_PAGE_ID || !ids.upload || !ids.live) return; // fail closed, like adminOk

  const store = EventStore.fromEnv(env);
  const health = await probes(env);

  let prev: Partial<Record<Component, Status>> = {};
  try {
    prev = (await store.readHealthState<Partial<Record<Component, Status>>>()) ?? {};
  } catch {}

  const state: Partial<Record<Component, Status>> = {};
  let changed = false;
  const failures: string[] = [];
  for (const c of COMPONENTS) {
    const { status, detail } = health[c];
    const { report, next } = decide(prev[c] ?? null, status);
    state[c] = next;
    if (!report) continue;
    const res = await fetch(
      `https://api.statuspage.io/v1/pages/${env.STATUSPAGE_PAGE_ID}/components/${ids[c]}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `OAuth ${env.STATUSPAGE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ component: { status: STATUSPAGE_STATUS[status] } }),
      }
    );
    res.body?.cancel();
    if (res.ok) {
      changed = true;
      console.log(`statuspage: ${c} ${report} (${detail})`);
    } else {
      // Keep the previous state so the next tick retries this component.
      state[c] = prev[c] ?? "up";
      failures.push(`${c}: HTTP ${res.status}`);
    }
  }
  if (changed) await store.writeHealthState(state).catch(() => {});
  if (failures.length) throw new Error(`statuspage PATCH failed: ${failures.join(", ")}`);
}
