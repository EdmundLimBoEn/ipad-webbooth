# Human action checklist — Photo Booth

Things only you can do. Everything else (code, Blob store, env vars, production
deploy, adding the domain to the project) is already done.



## 2. Booth upload key

The booth page asks for an upload key once (stored on the device afterward).
It is:

```
b29b8260981f1548
```

Enter this on each iPad/phone used to take photos. Guests viewing the live
gallery don't need it. To rotate it later:
`bunx wrangler secret put BOOTH_UPLOAD_KEY` (takes effect immediately).


## 4. Frame artwork — done

The four strip frames from `FRAMES.pdf` are live in
`public/templates/talent-beacon-9-anniversary/` (rendered at 720×2160), wired up
in `app/templates.ts` as `bgImage` with the photo holes measured. The Square
frame is unchanged. To add/replace a frame later: make/pick a group folder under
`public/templates/<group>/`, drop the PNG there, add the group to `GROUPS` and a
template entry with `group` + `bgImage` + `slots` (x/y/w/h in canvas pixels over
the holes), then `bun run deploy`. `bun test` checks the crop math.

## 4b. Enable frames per event (do this for every event!)

New events only get the pink Square frame by default. Open
`/{event}/admin`, enter the upload key, tick the frames that event may use, and
Save. **After deploying this change, re-enable the Talent Beacon frames for any
event that is still running** — they are hidden everywhere until ticked. The
admin page also has the photo zip export.

## 4c. Cloudflare migration — done (2026-07-05)

The app runs on Cloudflare Workers + R2. `photobooth.edmundlim.systems` is live
on the Worker; all 100 photos migrated (0 failures). Remaining for you:

- [ ] Test the camera on a real iPad against the new deployment (see §5).
- [ ] Once confident: cancel the Vercel Pro subscription. Keep the Vercel Blob
  store as-is — it's the untouched backup of every pre-migration photo.

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
