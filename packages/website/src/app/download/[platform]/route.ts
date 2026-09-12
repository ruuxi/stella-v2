import { NextResponse } from "next/server";

/**
 * Serve desktop downloads from the trusted stella.sh domain instead of the raw
 * Cloudflare R2 bucket host (`pub-…r2.dev`), which has no domain reputation.
 *
 * This is a 302 redirect, not a byte proxy: the installers are large (the
 * Windows build is ~350MB), too big to stream safely through a serverless
 * function within Vercel's response/time/memory limits. A redirect keeps the
 * asset on R2 (unchanged) while making the URL the user clicks — and the
 * navigation the browser initiates — `https://stella.sh/download/<platform>`.
 * That click origin is the trust signal we can improve without a code-signing
 * certificate, reducing SmartScreen friction for the still-unsigned build.
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
