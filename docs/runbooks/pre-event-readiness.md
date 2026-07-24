# Pre-event readiness

Use this checklist first on staging and then on production. Never reuse the production Event slug for a staging test.

## Event setup

- Choose one canonical lowercase slug containing only letters, digits, and single hyphens. Use an unguessable suffix for a private gallery.
- Open `/{event}/admin` with the environment's Admin Key.
- Enable only the approved Frames. Preview new artwork in `/frame-lab` and ensure `bun run validate:frames` passed before deployment.
- Generate and save a unique Booth Key. Record the plaintext securely; only its hash is stored.
- Copy the Booth and Live Gallery URLs into the event brief and projector device.

## End-to-end device test

Use a throwaway canonical Event on staging that is different from every
production Event. Perform this entire section on the actual target iPad over
staging HTTPS before production promotion:

1. Open the canonical Event URL, verify the Photo Outbox recovery status is visible before unlock, enter a valid Booth Key, and confirm camera readiness. A rejected key must not start the camera or remove pending photos.
2. Unlock once without **Remember on this iPad**, close the tab, and confirm a new Safari session asks for a key. Unlock with Remember enabled, relaunch, and confirm the Event is still authenticated without putting the key in the URL.
3. Capture a photo, interrupt its upload, reload, and confirm the same durable IndexedDB Photo Outbox item recovers. If the Booth reports memory-only persistence, stop: reload recovery is unavailable.
4. Disable the venue network, finish at least two captures, and confirm ordered pending state. Restore the network and verify automatic drain. Simulate a lost upload acknowledgement and confirm the acknowledged capture appears exactly once with the same stable identity.
5. Open the same Event in a second tab and confirm the Event lease permits only one ordered drain. Close the owner tab and confirm the other tab can take over only after the lease boundary.
6. Pause from Admin while the Booth is at the Frame picker and confirm the camera indicator turns off. Resume, start a real multi-shot Frame, pause during capture, and confirm the current composite reaches durable handoff before the camera stops; no new capture may start while paused.
7. In Admin, confirm the Booth heartbeat moves through live and stale states using its server timestamp, and that pause/connectivity detail contains no credential.
8. Add the canonical Event to the Home Screen. Launch it without a query string and confirm landscape standalone mode, the correct Event scope, icon, and no credential in the URL or manifest.
9. Confirm Screen Wake Lock remains active across foreground return. If the target iPadOS denies or lacks it, follow the displayed instructions and set **Settings → Display & Brightness → Auto-Lock → Never** for the event.
10. Queue one pending photo, use the discoverable Operator control, reject one wrong fresh key, then exit with a valid fresh Booth or Admin Key. Confirm the camera and wake lock release, heartbeat/poller/session activity stops, stored credentials clear, and the pending count remains intact after relaunch.

Then capture one photo with every enabled Frame and check crop, draw order,
orientation, color, and final resolution. Confirm each photo appears once in
the Live Gallery without a full-page refresh, exercise Save/Share on a phone,
and verify the Event export opens.

For moderation cleanup, first copy the complete throwaway image key and verify
that it belongs to the staging Event. Delete only that exact key; never use a
prefix, filename fragment, or production Event.

## Operational checks

- Confirm the production and staging domains show the intended build and do not share Event data.
- Confirm the health cron's last run succeeded. Its canary must pass binding write/read and public read, then be deleted by exact key.
- Confirm external uptime monitoring is green; it covers a fully dead Worker that self-reporting cannot see.
- Confirm projector power, screen sleep settings, venue Wi-Fi, charging, and the backup network.
- Confirm the Booth Photo Outbox is empty before doors open.

If any storage, authentication, moderation, or outbox check fails, do not open the Booth. Follow the rollback section in `deployment.md` or use the last verified deployment.
