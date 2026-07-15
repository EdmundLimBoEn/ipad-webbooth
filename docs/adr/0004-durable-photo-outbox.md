---
status: accepted
---

# Persist every composited photo until storage acknowledges it

The Booth Session owns a durable, ordered Photo Outbox because venue connectivity is unreliable and a later capture must never overwrite an earlier failed upload. A photo leaves the outbox only after Event storage acknowledges it; reload and reconnect recovery are part of the Booth Session interface.

## Consequences

Browser persistence is required on capable devices, with a visible degraded fallback when persistence is unavailable. Tests must cover multiple failures, later successes, retry ordering, and reload recovery.
