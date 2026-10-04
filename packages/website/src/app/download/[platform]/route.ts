import { NextResponse } from "next/server";

/**
 * Serve desktop downloads from the trusted stella.sh domain instead of the raw
 * Cloudflare R2 bucket host (`pub-…r2.dev`), which has no domain reputation.
 *
 * This is a 302 redirect, not a byte proxy: a redirect keeps the launcher on
 * R2 (unchanged) and off Vercel's function limits, while making the URL the
 * user clicks — and the navigation the browser initiates —
 * `https://stella.sh/download/<platform>`.
 */

import { RELEASE_ASSETS } from "@/lib/downloads";

const ASSETS: Record<string, string> = RELEASE_ASSETS;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform } = await params;
  const target = ASSETS[platform];

  // Unknown slug — send the visitor to the homepage to pick a download.
  if (!target) {
    return NextResponse.redirect(new URL("/", request.url), 302);
  }

  return NextResponse.redirect(target, 302);
}
