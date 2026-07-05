import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// This app is force-dynamic everywhere (upload/photos/config/export all opt
// out of caching), so no incremental-cache / KV / R2-cache overrides needed.
export default defineCloudflareConfig();
