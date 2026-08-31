import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

describe("website chat hosting", () => {
  test("owns public /chat while preserving the marketing Next application", () => {
    expect(read("packages/website/src/app/chat/chat-frame.tsx")).toContain(
      'const CHAT_APP_PATH = "/chat-app/index.html"',
    );
    const scripts = JSON.parse(read("packages/website/package.json")).scripts;
    expect(scripts.prebuild).toBe("bun run build:chat");
    expect(read("packages/desktop-ui/vite.config.ts")).toContain(
      'WEBSITE_BUILD ? "/chat-app/" : "./"',
    );
    const nextConfig = read("packages/website/next.config.ts");
    expect(nextConfig).toContain('source: "/chat-app/assets/:path*"');
    expect(nextConfig).toContain("max-age=31536000, immutable");
    expect(nextConfig).toContain("script-src 'self' 'unsafe-inline'");
    expect(nextConfig).toContain("desktopPublicEnv.VITE_CONVEX_URL");
  });

  test("hosted entry does not preload or invoke the onboarding chunk", () => {
    const htmlPath = path.join(
      repoRoot,
      "packages/website/public/chat-app/index.html",
    );
    if (!fs.existsSync(htmlPath)) return;
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).not.toMatch(/modulepreload[^>]+OnboardingOverlay/i);
    expect(read("packages/desktop-ui/src/shell/FullShell.tsx")).toContain(
      "platformCapabilities.onboarding ? <DesktopFullShell /> : <WebsiteShell />",
    );
  });
});
