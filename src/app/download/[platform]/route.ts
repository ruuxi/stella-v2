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

const R2_BASE =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop-v2/stable";

const ASSETS: Record<string, string> = {
  windows: `${R2_BASE}/Stella.exe`,
  "mac-arm64": `${R2_BASE}/Stella-darwin-arm64.dmg`,
  "mac-x64": `${R2_BASE}/Stella-darwin-x64.dmg`,
  linux: `${R2_BASE}/Stella-linux-x64.AppImage`,
  arch: `${R2_BASE}/Stella-arch-x64.pkg.tar.xz`,
};

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
