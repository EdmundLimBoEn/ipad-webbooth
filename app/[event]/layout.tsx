"use client";

import { ReactNode, useEffect } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { canonicalEvent, InvalidEventSlugError, slugifyEvent } from "../event-identity";

export default function EventLayout({ children }: { children: ReactNode }) {
  const { event } = useParams<{ event: string }>();
  const pathname = usePathname();
  const router = useRouter();
  let canonical = event;
  try {
    canonicalEvent(event);
  } catch (error) {
    if (error instanceof InvalidEventSlugError) canonical = slugifyEvent(event);
  }
  const needsCorrection = canonical !== event;

  useEffect(() => {
    if (!needsCorrection) return;
    const suffix = pathname.match(/\/(?:admin|live)$/)?.[0] ?? "";
    router.replace(`/${canonical}${suffix}`);
  }, [canonical, event, needsCorrection, pathname, router]);

  if (needsCorrection) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "#f2efe7", color: "#101010", textAlign: "center" }}>
        <div><p style={{ font: "800 12px ui-monospace, monospace", color: "#d41454", textTransform: "uppercase" }}>Correcting event address</p><h1 style={{ margin: "12px 0", font: "900 clamp(42px, 8vw, 80px)/.9 Impact, sans-serif", textTransform: "uppercase" }}>{canonical}</h1><p>This event has moved to its canonical lowercase URL.</p></div>
      </main>
    );
  }
  return children;
}
