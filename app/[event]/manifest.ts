import type { MetadataRoute } from "next";
import { canonicalEvent } from "../event-identity";

export default async function manifest({
  params,
}: {
  params: Promise<{ event: string }>;
}): Promise<MetadataRoute.Manifest> {
  const event = canonicalEvent((await params).event);
  const eventPath = `/${event}`;

  return {
    id: eventPath,
    name: `${event} Photo Booth`,
    short_name: "Photo Booth",
    start_url: eventPath,
    scope: eventPath,
    display: "standalone",
    orientation: "landscape",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: "/booth-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        // Web App Manifest allows a space-separated purpose list. Next's
        // MetadataRoute type currently narrows this valid value to one token.
        purpose: "any maskable" as "any",
      },
    ],
  };
}
