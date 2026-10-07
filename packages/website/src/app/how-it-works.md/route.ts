// Mirrors the /how-it-works → /learn-more redirect for the markdown variant.
import { PUBLIC_SITE } from "@/lib/site-url";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.redirect(new URL("/learn-more.md", PUBLIC_SITE), 308);
}
