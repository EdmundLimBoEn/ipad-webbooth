---
status: accepted
---

# Isolate preview and production releases

Preview and production use distinct Worker names, domains, R2 buckets, and secrets. A second hostname on the production Worker is not a staging environment because it cannot contain deploy, data, or credential failures.

## Consequences

Release commands must name their Wrangler environment explicitly, and preview smoke checks must pass before production promotion. Bucket creation and secret population remain deliberate operator actions.
