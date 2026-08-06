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

describe("agent model picker layout", () => {
  it("uses direct reasoning controls without redundant selection chrome", () => {
    const picker = readSource("global/settings/AgentModelPicker.jsx");
    const pickerStyles = readSource("global/settings/AgentModelPicker.css");
    const providerPanel = readSource("global/settings/ProviderModelPanel.jsx");
    const providerStyles = readSource(
      "global/settings/ProviderModelPicker.css",
    );

    expect(picker).not.toContain('from "@/ui/select"');
    expect(picker).not.toContain("agent-model-picker-engine-note");
    expect(picker).toContain('surface === "settings" ?');
    expect(picker).not.toContain('tabButton(ASSISTANT_TARGET, "Assistant"');
    expect(picker).toContain('role="radiogroup"');
    expect(picker).toContain('role="radio"');
    expect(picker).not.toContain('{ id: "default", label: "Default" }');
    expect(picker).toContain('savedReasoningEffort === "default"');
    expect(picker).toContain('selectedChatGptLiveModel?.defaultReasoningEffort');
    expect(pickerStyles).toContain(".agent-model-picker-reasoning-options");
    expect(providerPanel).not.toContain("model-picker-group-bar");
    expect(providerPanel).not.toContain("model-picker-group-rule");
    expect(providerPanel).not.toContain("model-picker-model-sub");
    expect(providerPanel).toContain('className="model-picker-search-row"');
    expect(providerPanel).toContain(
      "renderGroupActions(getSectionContext(tabs[0]))",
    );
    expect(providerStyles).toContain(
      ".model-picker-search-row .model-picker-search",
    );
  });
});
