// Wraps the OpenNext-generated worker to add a cron handler
// (https://opennext.js.org/cloudflare/howtos/custom-worker). No DO re-exports
// needed: open-next.config.ts uses no queue/tag-cache Durable Objects.
import type { ExportedHandler } from "@cloudflare/workers-types";
import { healthCheck } from "./app/health";

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

type WorkerFetch = NonNullable<ExportedHandler<CloudflareEnv>["fetch"]>;
type WorkerRequest = Parameters<WorkerFetch>[0];

export default {
  async fetch(request, env, ctx) {
    const localPhoto = await serveBoundPhoto(request, env);
    if (localPhoto) return localPhoto;
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(healthCheck(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;

async function serveBoundPhoto(request: WorkerRequest, env: CloudflareEnv): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const requestUrl = new URL(request.url);
  const publicBase = new URL(env.R2_PUBLIC_BASE);
  const basePath = publicBase.pathname.replace(/\/$/, "");
  // Only the same-origin local adapter is handled here. Production/staging use
  // their R2 public custom domains and pass through to OpenNext normally.
  if (requestUrl.origin !== publicBase.origin || basePath === "" || basePath === "/") return null;
  if (!requestUrl.pathname.startsWith(`${basePath}/`)) return null;

  let key: string;
  try {
    key = decodeURIComponent(requestUrl.pathname.slice(basePath.length + 1));
  } catch {
    return new Response("invalid photo key", { status: 400 });
  }
  const segments = key.split("/");
  if (!key || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) {
    return new Response("invalid photo key", { status: 400 });
  }
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  if (request.method === "HEAD") return new Response(null, { headers });
  const reader = object.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, { headers });
}
