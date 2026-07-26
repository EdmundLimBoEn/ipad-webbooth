import { InvalidEventSlugError } from "../../event-identity";
import eventManifest from "../manifest";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ event: string }> }
) {
  try {
    const body = await eventManifest(context);
    return new Response(JSON.stringify(body), {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/manifest+json; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof InvalidEventSlugError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
