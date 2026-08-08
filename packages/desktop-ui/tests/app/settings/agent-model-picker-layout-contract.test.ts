import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("full-area agent model picker layout", () => {
  it("renders one collapsible provider list with engine sections and inline reasoning under the selection", () => {
    const picker = readSource("global/settings/AgentModelPicker.tsx");
    const styles = readSource("global/settings/AgentModelPicker.css");

    expect(picker).toContain('tabButton(ASSISTANT_TARGET, "Assistant"');
    // Single list: no brand icon rail, no scoped brand header, no
    // subscription/API source dropdown — engines are their own sections.
    expect(picker).not.toContain("agent-model-picker-brands");
    expect(picker).not.toContain("agent-model-picker-brand-header");
    expect(picker).not.toContain("brandSearchOpen");
    expect(picker).not.toContain("Sign in with ChatGPT");
    expect(picker).toContain("collapsibleGroups");
    expect(picker).toContain("activeSectionKey={activeSectionKey}");
    expect(picker).toContain("hiddenProviders={HIDDEN_CATALOG_PROVIDERS}");
    expect(picker).toContain('const CHATGPT_SECTION_KEY = "chatgpt-engine"');
    expect(picker).toContain(
      'const CLAUDE_CODE_SECTION_KEY = "claude-code-engine"',
    );
    expect(picker).toContain('HIDDEN_CATALOG_PROVIDERS = ["openai-codex"]');
    expect(picker).toContain('role="radiogroup"');
    // Reasoning effort rides under the selected row, not a footer.
    expect(picker).toContain("selectedRowExtra={reasoningControl}");
    expect(picker).not.toContain("agent-model-picker-footer");
    expect(picker).toContain("oauthPendingProvider");
    expect(picker).toContain("cancelPendingOAuth");

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
    expect(panel).toContain("Cancel sign-in");
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
