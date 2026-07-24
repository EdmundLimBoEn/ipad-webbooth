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

### Release 2 guest capture and handoff

Continue on the same throwaway staging Event, target iPad, and staging HTTPS
hostname. The mocked WebKit journey is a repeatable regression check; it does
not replace any check in this section.

1. Capture every enabled Frame with the real iPad camera. Inspect the final
   canvas at its configured resolution for crop, orientation, background and
   overlay order, color, and memory stability. Exercise both one-shot and
   multi-shot Frames.
2. Confirm the review shows the exact completed composite. Retake and verify
   the same Frame remains selected. Accept and verify the Frame clears only
   after the photo is durably in the Photo Outbox.
3. Let auto-accept win once, cancel it with **More Time** once, and rapidly
   alternate **Use Photo** and **Retake** near the timeout. Each candidate must
   create at most one Outbox row and one capture identity.
4. Exercise an encoding failure on staging or a diagnostic build. Confirm no
   Outbox row is created, the error is announced, and **Use Photo** can retry
   or **Retake** can recover without reloading.
5. Deny or disable in-browser camera access and use the file-camera fallback
   with a real HEIC photo. Confirm decode, orientation, exact review, acceptance,
   and the accessible decode-error recovery path.
6. Pause the Event while a guest is reviewing, then while acceptance is
   persisting. Review must remain safe; acceptance must either reach durable
   handoff exactly once or report a recoverable error before the camera stops.
7. Disable the venue network, accept a photo, and confirm the queued handoff
   lets the next guest continue without inventing a QR. Restore connectivity
   and verify ordered upload with no duplicate object.
8. Queue two guests. Keep the older upload acknowledgement delayed until the
   newer handoff has begun. The older acknowledgement must not replace, reopen,
   or produce a QR for the current guest.
9. When the current acknowledgement arrives, compare the visible text link
   with the QR target. Scan the QR using a second physical phone and verify the
   staging Gallery opens the exact complete Event-owned key and photo. A
   localhost QR is not valid evidence.
10. With VoiceOver on the iPad and second phone, traverse Frame selection,
    countdown status, review actions, queued/ready handoff, direct-photo status,
    and save/share. Confirm logical focus order, visible focus, concise
    announcements, and no repeated or stale announcement.
11. Select Arabic and confirm right-to-left document direction, then `zh-SG`.
    Exercise an unavailable device/config locale and an absent localized Frame
    label; both must fall back to English/default Frame text without a blank
    control. Relaunch and confirm the supported Event-scoped locale persists.
12. Enable countdown audio after a guest gesture and confirm bounded countdown
    and shutter tones. Repeat with audio denied or unavailable: the visual
    countdown and capture must continue without an error.
13. Repeat the changed guest screens in installed landscape mode with Larger
    Text, Reduce Motion, and Increase Contrast/high-contrast settings. Confirm
    review controls, QR text link, and next-guest action remain visible and
    keyboard/Switch Control operable.

Record the Event slug, build revision, iPad/iPadOS model, second-phone model,
enabled Frames, and pass/fail result for every item. Release 2 is not complete
and production must not be promoted until every real-device item passes. Never
remove test photos by prefix; copy and delete only each complete Event-owned
image key intended for cleanup.

### Release 3 gallery and moderation

Continue with a throwaway canonical staging Event that is distinct from
production:

1. Upload enough exact photos to require multiple moderation pages. Interrupt
   and resume the bounded add-only index rebuild, then confirm its checkpoint,
   completion marker, index, and receipts exist only in staging `STATE`.
2. Leave the physical projector running while photos arrive. Verify adaptive
   polling, independent looping columns, four-second manual-scroll pause,
   motion quality, visible gaps, and browse-QR readability at venue distance.
3. On a physical phone, keep an older tile in view while several photos arrive.
   Confirm the visible exact-key anchor stays put, the new-photo count is
   correct, and **Jump to latest** returns to the newest-first edge.
4. Open an exact handoff deep link before the browse feed settles. Exercise
   native Share/Save, including cancellation, and confirm the shared dialog
   uses the same complete key and URL.
5. Filter and page Admin moderation, inspect with previous/next and arrow keys,
   close with Escape, and verify focus returns to the exact originating tile.
6. Delete one designated canary using its complete Event-owned key. Confirm
   adjacent public photos and private records remain byte-identical.
7. Simulate a derived cleanup failure. The public photo must remain deleted,
   disappear from moderation, show only a cleanup warning, and never invite a
   second public DELETE.
8. Exercise the complete flow keyboard-only and with VoiceOver, Arabic RTL,
   200% text, Reduce Motion, and high contrast. Obtain native-speaker review
   for supported non-English catalog changes.

Automated WebKit cannot certify iOS native Share activation or Save to Photos,
VoiceOver speech timing, Safari process suspension, long-running physical
projector performance, production-like R2 races, or translation quality.
Never use prefix cleanup; retain abandoned staging records or remove each
intended photo individually by complete key.

### Release 4 guided rehearsal

Run the guided rehearsal on the actual target iPad over staging HTTPS:

1. Apply the intended preset to a throwaway canonical staging Event, then
   separately install and verify that Event's Booth Key.
2. Open the generated rehearsal link and verify authenticated preflight,
   camera readiness, and durable IndexedDB before accepting evidence.
3. Capture and accept one photo with every snapshotted Frame; inspect each
   physical composition.
4. Create two genuine network-class upload failures on two distinct captures,
   reload Safari, and confirm a different boot ID recovers both exact rows.
5. Reconnect and confirm exact oldest-first drain with no duplicate public
   photos or acknowledgements.
6. Observe one acknowledged exact key in the public Photo Feed and fetch its
   public bytes.
7. Designate that exact key as the moderation canary, delete it through the
   existing exact-key endpoint, and verify adjacent photos remain.
8. Explicitly retain or individually delete every other rehearsal photo.
   Completion and abandonment must never perform automatic cleanup.
9. Confirm the Photo Outbox and rehearsal evidence outbox are both empty.
10. Complete projector, power, charging, and backup-network manual checks.
11. Change config once and verify the old immutable rehearsal becomes stale.
    Start a new rehearsal rather than rewriting its snapshot or evidence.

A browser simulator cannot prove real camera composition, Safari
IndexedDB/suspension behavior, genuine venue-network failure, installed wake
behavior, projector crop/brightness/motion, charging and power, backup
network, or VoiceOver. Record the Event, build, devices, exact remaining keys,
and every result. Production promotion remains blocked until they pass.

Then capture one photo with every enabled Frame and check crop, draw order,
orientation, color, and final resolution. Confirm each photo appears once in
the Live Gallery without a full-page refresh, exercise Save/Share on a phone,
and verify the Event export opens.

For moderation cleanup, first copy the complete throwaway image key and verify
that it belongs to the staging Event. Delete only that exact key; never use a
prefix, filename fragment, or production Event.

## Post-event package rehearsal

Use a throwaway canonical staging Event with a configured timezone and a
fixture containing a current framed photo, a camera-fallback photo, a legacy
photo without a receipt, and a removed/unknown historical Frame.

1. Download the photo-only ZIP and confirm every photo remains at the archive
   root with no generated entries.
2. Download the enriched package and confirm it contains `photos/`,
   `manifest.csv`, `summary.json`, and `contact-sheet.html`.
3. Run `unzip -t <event>-package.zip` and require a clean result.
4. Extract the package, disable networking, and open
   `contact-sheet.html`. Confirm every image loads through its relative
   `photos/` path.
5. Open print preview and inspect the grid, page breaks, captions, and target
   paper size.
6. Import `manifest.csv` into Excel, Numbers, or Google Sheets and confirm
   formula-looking fixture cells remain text.
7. Compare the configured timezone, first/last capture, hourly and busiest
   periods, Frame usage, byte totals, and metadata-coverage totals against the
   fixture.
8. Delete only one designated throwaway photo by its complete Event-owned key,
   export again, and confirm it is absent from photos, manifest, summary, and
   contact sheet.
9. Search the extracted package for `photo-metadata`, `photo-index`, revision
   IDs, Booth records, rehearsal evidence, health state, hashes, credentials,
   and private storage prefixes. None may be present.

The automated suite cannot certify native desktop file-picker streaming,
production-like R2 behavior during a long response, spreadsheet application
imports, offline extracted-file policy, or the operator's actual printer.
Record those manual desktop/staging results before relying on the post-event
package.

## Operational checks

- Confirm the production and staging domains show the intended build and do not share Event data.
- Confirm the health cron's last run succeeded. Its canary must pass binding write/read and public read, then be deleted by exact key.
- Confirm external uptime monitoring is green; it covers a fully dead Worker that self-reporting cannot see.
- Confirm projector power, screen sleep settings, venue Wi-Fi, charging, and the backup network.
- Confirm the Booth Photo Outbox is empty before doors open.

If any storage, authentication, moderation, or outbox check fails, do not open the Booth. Follow the rollback section in `deployment.md` or use the last verified deployment.
