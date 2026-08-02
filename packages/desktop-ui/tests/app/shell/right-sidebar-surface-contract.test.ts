import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getThemeById, resolveThemeColors } from "@/shared/theme/themes";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

describe("right-sidebar surface contracts", () => {
  it("keeps normal right-sidebar chat on its existing transparent canvas", () => {
    const component = readSource("shell/ChatSidebar.tsx");
    const css = readSource("shell/chat-sidebar.css");
    const normalChatFrame = ruleBody(
      css,
      ".chat-panel-tab .chat-sidebar-inner",
    );

    expect(component).toContain("chat-panel-tab chat-panel-tab--${variant}");
    expect(normalChatFrame).toMatch(/background:\s*transparent/);
    expect(normalChatFrame).toMatch(/backdrop-filter:\s*none/);
    expect(normalChatFrame).toMatch(/box-shadow:\s*none/);
  });

  it("keeps read-only General and Manager threads on that same canvas", () => {
    const component = readSource("shell/display/ThreadChatTab.tsx");
    const css = readSource("shell/display/thread-chat-tab.css");

    expect(component).toContain('className="chat-panel-tab thread-chat-tab"');
    expect(component).toContain('aria-label="Read-only agent thread"');
    expect(component).toContain("data-agent-type={transcript?.agentType}");

    for (const selector of [
      ".thread-chat-tab",
      ".thread-chat-tab__header",
      ".thread-chat-tab__scroll",
    ]) {
      expect(ruleBody(css, selector)).toMatch(/background:\s*transparent/);
    }

    expect(ruleBody(css, ".thread-chat-tab__header")).toMatch(
      /border-bottom:\s*1px solid var\(--border\)/,
    );
    expect(css).not.toMatch(
      /var\(--(?:sidebar|surface-base|panel-surface-bg|panel-surface-border)/,
    );
  });

  it("shares the main composer surface with Media without nesting a second surface", () => {
    const sharedCss = readSource("features/chat/composer-surface.css");
    const mainComponent = readSource("app/chat/Composer.tsx");
    const mainCss = readSource("app/chat/full-shell.composer.css");
    const mediaComponent = readSource(
      "shell/display/media-tab/MediaTabContent.tsx",
    );
    const mediaCss = readSource("shell/display/media-tab.css");
    const animation = readSource("shared/hooks/use-animated-composer-shell.ts");
    const surface = ruleBody(sharedCss, ".composer-surface");

    expect(mainComponent).toContain("composer-shell composer-surface");
    expect(mediaComponent).toContain("media-tab__composer composer-surface");
    expect(surface).toMatch(/background:\s*var\(--panel-surface-bg-gradient\)/);
    expect(surface).toMatch(
      /border:\s*1px solid var\(--panel-surface-border\)/,
    );
    expect(surface).toMatch(
      /box-shadow:\s*var\(--shadow-sm\), var\(--panel-surface-highlight\)/,
    );
    expect(ruleBody(sharedCss, ".composer-surface:focus-within")).toMatch(
      /var\(--primary\).*var\(--border\)/,
    );
    expect(sharedCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.composer-surface\s*\{[^}]*transition:\s*none/,
    );

    expect(ruleBody(mainCss, ".composer-shell")).not.toMatch(
      /(?:background|border|box-shadow):/,
    );
    const mediaComposer = ruleBody(mediaCss, ".media-tab__composer");
    expect(mediaComposer).not.toMatch(/(?:background|box-shadow):/);
    expect(mediaComposer).toMatch(/border-radius:\s*20px/);
    expect(animation).toMatch(/const expandedRadiusPx = 20/);

    const mediaRow = ruleBody(mediaCss, ".media-tab__composer-row");
    expect(mediaRow).toMatch(/border:\s*none/);
    expect(mediaRow).toMatch(/background:\s*transparent/);
  });

  it("keeps the shared surface and Media controls theme- and state-aware", () => {
    const sharedCss = readSource("features/chat/composer-surface.css");
    const mediaCss = readSource("shell/display/media-tab.css");
    const surface = ruleBody(sharedCss, ".composer-surface");
    const defaultTheme = getThemeById("default");
    const gradientTheme = getThemeById("aura");

    expect(defaultTheme).toBeDefined();
    expect(gradientTheme).toBeDefined();
    expect(defaultTheme?.flat).toBe(true);
    expect(gradientTheme?.flat).not.toBe(true);

    const palettes = [
      resolveThemeColors(defaultTheme!, false).colors,
      resolveThemeColors(defaultTheme!, true).colors,
      resolveThemeColors(gradientTheme!, false).colors,
      resolveThemeColors(gradientTheme!, true).colors,
    ];
    expect(new Set(palettes.map((colors) => colors.background)).size).toBe(4);
    for (const colors of palettes) {
      expect(colors.background).toBeTruthy();
      expect(colors.border).toBeTruthy();
      expect(colors.primary).toBeTruthy();
    }

    expect(surface).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(ruleBody(mediaCss, ".media-tab__mode:disabled")).toMatch(
      /opacity:\s*0\.35/,
    );
    expect(
      ruleBody(mediaCss, ".media-tab__prompt-submit:focus-visible"),
    ).toMatch(/box-shadow:\s*var\(--focus-ring\)/);
    expect(ruleBody(mediaCss, ".media-tab__prompt-submit:disabled")).toMatch(
      /opacity:\s*0\.35/,
    );
  });
});
