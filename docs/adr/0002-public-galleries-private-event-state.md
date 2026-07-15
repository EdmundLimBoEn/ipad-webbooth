---
status: accepted
---

# Keep galleries public by capability while event state stays private

Event galleries are public to anyone who knows the non-obvious canonical Event slug, and photo objects are served directly through the public R2 domain. Event configuration, Booth Key hashes, health state, and other operational records belong in a separate private R2 binding so public delivery does not expose state that guests never need.

## Consequences

Deployments must migrate or fall back to legacy `_config/` and `_health/` objects in the photo bucket until private state has been copied safely. No migration may bulk-delete photo storage.
