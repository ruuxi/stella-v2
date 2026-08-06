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
  it("keeps provider actions at the top and reasoning as the only footer control", () => {
    const picker = readSource("global/settings/AgentModelPicker.jsx");
    const styles = readSource("global/settings/AgentModelPicker.css");

    expect(picker).toContain('tabButton(ASSISTANT_TARGET, "Assistant"');
    expect(picker).toContain('className="agent-model-picker-brand-header"');
    expect(picker).toContain("agent-model-picker-connect-btn");
    expect(picker).toContain("Sign in with ChatGPT");
    expect(picker).toContain("authOpenRequest={brandAuthOpenRequest}");
    expect(picker).toContain("brandSearchOpen");
    expect(picker).toContain('role="radiogroup"');
    expect(picker).not.toContain("agent-model-picker-engine-note");
    expect(picker).not.toContain("agent-model-picker-fast-toggle");
    expect(picker).not.toContain("Use Codex instead");
    expect(picker).not.toContain("Use Claude Code instead");
    expect(picker).not.toContain("agent-model-picker-source-select");
    expect(picker).not.toContain("ChatGPT is disconnected.");

    expect(styles).toContain(".agent-model-picker-brand-header {");
    expect(styles).toContain(".agent-model-picker-reasoning-options {");
    expect(styles).toContain("border-color: var(--border);");
    expect(styles).not.toContain("background: var(--select-fill);");
  });

  it("keeps search and auth actions without the provider status rail", () => {
    const panel = readSource("global/settings/ProviderModelPanel.jsx");
    const styles = readSource("global/settings/ProviderModelPicker.css");

    expect(panel).toContain('className="model-picker-search-row"');
    expect(panel).toContain("headerActionsTarget");
    expect(panel).not.toContain("model-picker-group-bar");
    expect(panel).not.toContain("model-picker-group-rule");
    expect(styles).toContain(".model-picker-search-row {");
    expect(styles).not.toContain(".model-picker-group-bar");
    expect(styles).not.toContain(".model-picker-group-rule");
    expect(styles).toContain(".model-picker-model[data-selected]");
    expect(styles).not.toContain("background: var(--select-fill);");
    expect(styles).toContain("padding: 5px 10px;");
  });
});
