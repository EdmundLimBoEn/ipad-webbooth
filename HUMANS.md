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


## 4. Swapping in the real strip/border artwork (when your friend sends it)

Right now the borders are demo colors (soft pink square, Barbie-pink strip). To
use real art, edit `app/templates.ts`:

- Drop the PNG(s) into `public/templates/` (e.g. `public/templates/strip.png`).
- On the template, set `overlay: "/templates/strip.png"` (frame art with holes,
  drawn on top of the photos) **or** `bgImage: "/templates/strip.png"` (art
  behind the photos). Remove/keep `background` as needed.
- Adjust the `slots` (x/y/w/h in canvas pixels) so the photos line up with the
  holes in the art. Canvas sizes: square `1080×1080`, strip `600×1800`.

Redeploy with `vercel --prod` after editing. `bun test` checks the crop math.

## 5. During the event

- Open the booth URL on the iPad in Safari, allow camera access when prompted.
- Walk-up flow: pick **Square** (1 photo) or **Photo Strip** (3 photos, 10s
  between each), then press the shutter/▶.
- Put the live gallery URL on a laptop/projector/TV. Tap any photo → **Save
  photo** (on phones this opens the share sheet → Save to Photos).
- To remove a photo: Vercel dashboard → Storage → `photobooth` blob store → delete the blob.
- **Test the camera + both modes on a real iPad before the event** — camera
  capture can't be verified headlessly, only on-device over HTTPS.
