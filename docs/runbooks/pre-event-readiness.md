# Pre-event readiness

Use this checklist first on staging and then on production. Never reuse the production Event slug for a staging test.

## Event setup

- Choose one canonical lowercase slug containing only letters, digits, and single hyphens. Use an unguessable suffix for a private gallery.
- Open `/{event}/admin` with the environment's Admin Key.
- Enable only the approved Frames. Preview new artwork in `/frame-lab` and ensure `bun run validate:frames` passed before deployment.
- Generate and save a unique Booth Key. Record the plaintext securely; only its hash is stored.
- Copy the Booth and Live Gallery URLs into the event brief and projector device.

## End-to-end device test

1. On the actual iPad over HTTPS, allow camera access and enter the Booth Key.
2. Capture one photo with every enabled Frame. Check crop, draw order, orientation, color, and final resolution.
3. Disable the network, finish two captures, and confirm both appear as pending in order.
4. Reload once and confirm durable queued photos recover. If the Booth reports degraded persistence, stop: IndexedDB is unavailable and reload recovery is not guaranteed.
5. Restore the network, retry, and wait until the pending count reaches zero.
6. Confirm each new photo appears once in the Live Gallery without a full-page refresh.
7. Open a photo on a phone and exercise Save/Share.
8. In Admin, upload a throwaway photo, verify its exact Event/key, delete that exact object, and ensure adjacent photos remain.
9. Export the Event and verify the zip opens.

## Operational checks

- Confirm the production and staging domains show the intended build and do not share Event data.
- Confirm the health cron's last run succeeded. Its canary must pass binding write/read and public read, then be deleted by exact key.
- Confirm external uptime monitoring is green; it covers a fully dead Worker that self-reporting cannot see.
- Confirm projector power, screen sleep settings, venue Wi-Fi, charging, and the backup network.
- Confirm the Booth Photo Outbox is empty before doors open.

If any storage, authentication, moderation, or outbox check fails, do not open the Booth. Follow the rollback section in `deployment.md` or use the last verified deployment.
