import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import enCatalog from "../../../src/shared/i18n/locales/en.json";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

const englishFor = (key: string): string => {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      enCatalog,
    );
  expect(typeof value, `${key} missing from en.json`).toBe("string");
  return value as string;
};

describe("full-area agent model picker layout", () => {
  it("renders one collapsible provider list with engine sections and inline reasoning under the selection", () => {
    const picker = readSource("global/settings/AgentModelPicker.tsx");
    const styles = readSource("global/settings/AgentModelPicker.css");

    expect(englishFor("settings.agentModelPicker.tabs.assistant")).toBe(
      "Assistant",
    );

    expect(picker).toMatch(
      /tabButton\(\s*ASSISTANT_TARGET,\s*t\("settings\.agentModelPicker\.tabs\.assistant"\)/,
    );

    expect(picker).not.toContain("agent-model-picker-brands");
    expect(picker).not.toContain("agent-model-picker-brand-header");
    expect(picker).not.toContain("brandSearchOpen");

    expect(picker).not.toContain("Sign in with ChatGPT");
    expect(picker).not.toMatch(/signInWith\s*Chat\s*GPT/i);
    expect(picker).not.toMatch(/chatgpt\w*\.?signIn/i);
    expect(picker).toContain("collapsibleGroups");
    expect(picker).toContain("activeSectionKey={activeSectionKey}");
    expect(picker).toContain("hiddenProviders={HIDDEN_CATALOG_PROVIDERS}");
    expect(picker).toContain('const CHATGPT_SECTION_KEY = "chatgpt-engine"');
    expect(picker).toContain(
      'const CLAUDE_CODE_SECTION_KEY = "claude-code-engine"',
    );
    expect(picker).toContain('HIDDEN_CATALOG_PROVIDERS = ["openai-codex"]');
    expect(picker).toContain('role="radiogroup"');

    expect(picker).toContain("selectedRowExtra={reasoningControl}");
    expect(picker).toContain("selectedRowExtra={claudeCodeSelectionControls}");
    expect(picker).toContain("selectedRowExtra={chatGptSelectionControls}");
    expect(picker).not.toContain("agent-model-picker-footer");
    expect(picker).toContain("oauthPendingProvider");
    expect(picker).toContain("cancelPendingOAuth");
    expect(picker).toContain("Use Codex instead");
    expect(picker).toContain("Use Claude Code instead");
    expect(picker).toContain(
      'handleNativeRuntimeChange("useNativeCodexRuntime"',
    );
    expect(picker).toContain("Requires a separately installed Codex CLI");
    expect(picker).toContain(
      'handleNativeRuntimeChange("useNativeClaudeCodeRuntime"',
    );
    expect(picker).toContain('label="Fast"');
    expect(picker).toContain("selectedChatGptSupportsFast ?");
    expect(picker).toContain("handleCodexServiceTierSelect(");
    expect(picker).not.toContain("void handleCodexServiceTierSelect;");
    expect(styles).toContain(".agent-model-picker-engine-options {");
    expect(styles).toContain(".agent-model-picker-selected-controls {");

    expect(styles).not.toContain(".agent-model-picker-brand-header {");
    expect(styles).not.toContain(".agent-model-picker-brands {");
    expect(styles).toContain(".agent-model-picker-reasoning-options {");
    expect(styles).not.toContain("background: var(--select-fill);");
  });

  it("keeps search and auth actions without the provider status rail", () => {
    const panel = readSource("global/settings/ProviderModelPanel.tsx");
    const styles = readSource("global/settings/ProviderModelPicker.css");

    expect(panel).toContain('className="model-picker-search-row"');
    expect(panel).toContain("headerActionsTarget");
    expect(panel).toContain("const signOut = liftedRemovable");
    expect(panel).toContain("onClick: () => void handleSignOut(liftedTabKey)");
    expect(panel).not.toContain("model-picker-group-bar");
    expect(panel).not.toContain("model-picker-group-rule");
    expect(englishFor("settings.modelPicker.cancelSignIn")).toBe(
      "Cancel sign-in",
    );
    expect(panel).toContain('t("settings.modelPicker.cancelSignIn")');
    expect(panel).toContain("cancelPendingOAuth");
    expect(panel).toContain("model-picker-group-toggle");
    expect(panel).toContain("renderExtraSection");
    expect(styles).toContain(".model-picker-group-toggle {");
    expect(styles).toContain(".model-picker-search-row {");
    expect(styles).not.toContain(".model-picker-group-bar");
    expect(styles).not.toContain(".model-picker-group-rule");
    expect(styles).toContain(".model-picker-model[data-selected]");
    expect(styles).not.toContain("background: var(--select-fill);");
    expect(styles).toContain("padding: 5px 10px;");
  });

  it("keeps Codex discovery native-only, inline, and out of the toast", () => {
    const picker = readSource("global/settings/AgentModelPicker.tsx");
    const miniPicker = readSource("app/chat/MiniModelPicker.jsx");
    const toastEffectStart = picker.indexOf("const lastToastedErrorRef =");
    const toastEffectEnd = picker.indexOf(
      "void validateOAuth(OPENAI_CODEX_PROVIDER)",
      toastEffectStart,
    );

    expect(toastEffectStart).toBeGreaterThanOrEqual(0);
    expect(toastEffectEnd).toBeGreaterThan(toastEffectStart);
    expect(picker.slice(toastEffectStart, toastEffectEnd)).not.toContain(
      "codexCatalog.error",
    );
    expect(picker).toMatch(
      /const codexCatalogEnabled = active\s*&&\s*nativeCodexRuntimeEnabled\s*&&\s*\(chatGptSectionOpen\s*\|\|\s*committedEngine\s*===\s*"codex_cli"\)/,
    );
    expect(picker).toContain(
      "const codexCatalog = useCodexModelCatalog(codexCatalogEnabled)",
    );
    expect(picker).toMatch(
      /if \(!nativeCodexRuntimeEnabled\)\s*return listChatGptCatalogModels\(allModels\)/,
    );
    expect(picker).toMatch(
      /content: \(\) => \(nativeCodexRuntimeEnabled\s*&&\s*codexCatalog\.error/,
    );
    expect(miniPicker).toMatch(
      /useCodexModelCatalog\(committedEngine\s*===\s*"codex_cli"\s*&&\s*nativeCodexRuntimeEnabled\)/,
    );
    expect(picker).toContain("chatGptRegistryOptions");
    expect(picker).toContain(": chatGptRegistryOptions");
  });

  it("keeps native engine rows aligned with provider model rows", () => {
    const providerStyles = readSource(
      "global/settings/ProviderModelPicker.css",
    );
    const engineStyles = readSource(
      "global/settings/EngineScopedModelList.css",
    );

    for (const declaration of [
      "padding: 5px 10px;",
      "border-radius: var(--radius-sm, 6px);",
      "border-color: var(--select-surface-border);",
      "font-size: var(--font-size-base);",
    ]) {
      expect(providerStyles).toContain(declaration);
      expect(engineStyles).toContain(declaration);
    }
    expect(engineStyles).toContain("padding: 14px 14px 4px;");
    expect(engineStyles).toContain("padding: 0 12px 18px 0;");
  });
});
