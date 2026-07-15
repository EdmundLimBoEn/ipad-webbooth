// Compatibility entry point. The former one-time migration is now an additive
// backup reconciliation that never deletes from Vercel Blob or R2.
import "./reconcile-vercel-backup";
