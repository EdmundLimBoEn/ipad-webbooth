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
gallery don't need it. To rotate it later: `vercel env rm BOOTH_UPLOAD_KEY` then
re-add, and redeploy.


## 4. Frame artwork — done

The four strip frames from `FRAMES.pdf` are live as `public/templates/{beacon,
birthday,sheep,starry}.png` (rendered at 720×2160), wired up in `app/templates.ts`
as `bgImage` with the photo holes measured. The Square frame is unchanged. To
add/replace a frame later: drop a PNG in `public/templates/`, add a template
entry with `bgImage` + `slots` (x/y/w/h in canvas pixels over the holes), then
`vercel --prod`. `bun test` checks the crop math.

**Deploy the frames:** run `vercel --prod` so the new PNGs and code go live.

## 5. During the event

- Open the booth URL on the iPad in Safari, allow camera access when prompted.
- Walk-up flow: pick a 1-photo square frame — **Square / Lighthouse / Beacon
  Square** (from `SQUARE FRAME.pdf`) — or one of the four strip frames —
  **Beacon / Birthday / Baaa-thday / Starry** (3 photos each) — then press the
  shutter/▶. The preview crops to the frame's photo shape so guests frame
  themselves correctly.
- Put the live gallery URL on a laptop/projector/TV. Tap any photo → **Save
  photo** (on phones this opens the share sheet → Save to Photos).
- To remove a photo: Vercel dashboard → Storage → `photobooth` blob store → delete the blob.
- **Test the camera + both modes on a real iPad before the event** — camera
  capture can't be verified headlessly, only on-device over HTTPS.
