// Wraps the OpenNext-generated worker to add a cron handler
// (https://opennext.js.org/cloudflare/howtos/custom-worker). No DO re-exports
// needed: open-next.config.ts uses no queue/tag-cache Durable Objects.
import type { ExportedHandler } from "@cloudflare/workers-types";
import { healthCheck } from "./app/health";

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(healthCheck(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
