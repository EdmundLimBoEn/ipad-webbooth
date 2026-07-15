---
status: accepted
---

# Run on Cloudflare Workers with R2 as the data model

The photo booth runs as a Next.js application on Cloudflare Workers and uses R2, not a database or WebSockets, for Event configuration and photos. This keeps the live-event system small, inexpensive, and operable through bindings; the Live Gallery polls a Photo Feed and public photo bytes bypass the Worker.

## Consequences

Backend improvements must deepen the Event Store without quietly introducing a second source of truth. An R2-derived read model is acceptable when it preserves concurrent uploads and can be rebuilt from stored photos.
