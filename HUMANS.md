# Human action checklist — Photo Booth

Things only you can do. Everything else (code, Blob store, env vars, production
deploy, adding the domain to the project) is already done.



## 4b. Enable frames per event (do this for every event!)

New events only get the pink Square frame by default. Open
`/{event}/admin`, enter the upload key, tick the frames that event may use, and
Save. **After deploying this change, re-enable the Talent Beacon frames for any
event that is still running** — they are hidden everywhere until ticked. The
admin page also has the photo zip export.

## 5. During the event

- Open the booth URL on the iPad in Safari, allow camera access when prompted.
- Walk-up flow: pick a 1-photo square frame — **Square / Lighthouse / Beacon
  Square** (from `SQUARE FRAME.pdf`) — or one of the four strip frames —
  **Beacon / Birthday / Baaa-thday / Starry** (3 photos each) — then press the
  shutter/▶. The preview crops to the frame's photo shape so guests frame
  themselves correctly.
- Put the live gallery URL on a laptop/projector/TV. Tap any photo → **Save
  photo** (on phones this opens the share sheet → Save to Photos).
- To remove a photo: Cloudflare dashboard → R2 → `photobooth` bucket → delete the object
  (or `bunx wrangler r2 object delete "photobooth/<event>/<file>.jpg" --remote`).
- **Test the camera + both modes on a real iPad before the event** — camera
  capture can't be verified headlessly, only on-device over HTTPS.
