# iPad Photo Booth

The iPad Photo Booth captures framed event photos on a guest-facing device and publishes them to a live gallery. This vocabulary names the concepts shared by capture, event setup, storage, and gallery modules.

## Events and access

**Event**:
A canonical, slug-identified photo booth occasion whose frames, booth access, photos, and exports are isolated from every other occasion.
_Avoid_: Tenant, namespace, folder

**Event Readiness**:
The operator-visible facts that determine whether an Event is ready for guests: canonical identity, selected Frame Packs, booth access, storage health, and tested links.
_Avoid_: Setup status, deployment status

**Admin Key**:
The production secret that permits Event configuration, moderation, and bulk export across Events.
_Avoid_: Upload key, master password

**Booth Key**:
A revocable credential scoped to one Event and permitted only to upload photos to that Event.
_Avoid_: Event password, guest key

## Capture and frames

**Booth**:
The guest-facing camera experience that selects a frame, captures its required shots, composites them, and queues the result for upload.
_Avoid_: Kiosk, camera page

**Booth Session**:
One Booth runtime on one device, including camera state, capture sequencing, compositing, and recovery of photos waiting to upload.
_Avoid_: UI state, capture hook

**Photo Outbox**:
The durable ordered collection of composited photos that have not yet been acknowledged by Event storage.
_Avoid_: Pending blob, retry queue

**Frame Pack**:
A colocated design drop containing artwork, frame manifests, slot geometry, and representative previews for one visual theme.
_Avoid_: Template group, asset folder

**Frame**:
One guest-selectable composition inside a Frame Pack, defining its canvas, shot count, photo slots, fit, and artwork draw order.
_Avoid_: Mode, template

## Storage and viewing

**Event Store**:
The module that owns canonical Event identity, object keys, Event configuration, photo ordering, pagination, and visibility across R2 adapters.
_Avoid_: R2 helper, repository, persistence helper

**Live Gallery**:
The public, polling photo display for one Event, including its projector marquee, lightbox, and device-save flow.
_Avoid_: Feed page, slideshow

**Photo Feed**:
The ordered snapshot-and-delta view of an Event's stored photos consumed by the Live Gallery.
_Avoid_: photo-list route, catalog endpoint
