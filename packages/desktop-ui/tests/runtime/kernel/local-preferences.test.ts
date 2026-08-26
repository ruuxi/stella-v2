import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalPreferences,
  normalizeImageGenerationPreferences,
  normalizeRealtimeVoicePreferences,
  resolveRealtimeUnderlyingProvider,
  resolveRealtimeVoiceId,
  updateLocalModelPreferences,
} from "@stella/runtime/kernel/preferences/local-preferences";
import { hasRealtimeVoiceSessionRouteChanged } from "@stella/contracts/local-preferences";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const makeStellaDataDir = () => tempDirs.create("stella-local-preferences-");

const writePreferences = (
  stellaDataDir: string,
  preferences: Record<string, unknown>,
) => {
  fs.mkdirSync(stellaDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(stellaDataDir, "preferences.json"),
    JSON.stringify(preferences),
  );
};

describe("loadLocalPreferences", () => {
  it("leaves reasoning unset so the selected model supplies its default", () => {
    const stellaDataDir = makeStellaDataDir();

    expect(loadLocalPreferences(stellaDataDir).reasoningEfforts).toEqual({});
  });

  it("persists engine-scoped Stella state and normalizes Claude minimal", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      stellaConversationModelOverrides: {
        orchestrator: " anthropic/claude-opus-4.8 ",
      },
      stellaConversationReasoningEfforts: { orchestrator: "high" },
      claudeCodeReasoningEffort: "minimal",
    });
    const loaded = loadLocalPreferences(stellaDataDir);
    expect(loaded.stellaConversationModelOverrides).toEqual({
      orchestrator: "anthropic/claude-opus-4.8",
    });
    expect(loaded.stellaConversationReasoningEfforts).toEqual({
      orchestrator: "high",
    });
    expect(loaded.claudeCodeReasoningEffort).toBe("low");
  });
  it("defaults wake-word listening off when the preference is missing", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).wakeWordEnabled).toBe(false);
  });

  it("drops retired working-mode fields on load and the next preference save", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      assistantWorkingMode: "direct",
      assistantWorkingModeDefaultVersion: 1,
      memoryEnabled: true,
    });

    expect(loadLocalPreferences(stellaDataDir)).not.toHaveProperty(
      "assistantWorkingMode",
    );
    expect(loadLocalPreferences(stellaDataDir)).not.toHaveProperty(
      "assistantWorkingModeDefaultVersion",
    );
    const saved = updateLocalModelPreferences(stellaDataDir, {
      memoryEnabled: false,
    });
    expect(saved).not.toHaveProperty("assistantWorkingMode");
    const persisted = JSON.parse(
      fs.readFileSync(path.join(stellaDataDir, "preferences.json"), "utf8"),
    );
    expect(persisted).not.toHaveProperty("assistantWorkingMode");
    expect(persisted).not.toHaveProperty("assistantWorkingModeDefaultVersion");
    expect(persisted.memoryEnabled).toBe(false);
  });

  it("enables memory by default and persists an explicit opt-out", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).memoryEnabled).toBe(true);

    const saved = updateLocalModelPreferences(stellaDataDir, {
      memoryEnabled: false,
    });
    expect(saved.memoryEnabled).toBe(false);
    expect(loadLocalPreferences(stellaDataDir).memoryEnabled).toBe(false);
  });

  it("preserves an explicit wake-word preference", () => {
    const enabledHome = makeStellaDataDir();
    writePreferences(enabledHome, { wakeWordEnabled: true });

    expect(loadLocalPreferences(enabledHome).wakeWordEnabled).toBe(true);

    const disabledHome = makeStellaDataDir();
    writePreferences(disabledHome, { wakeWordEnabled: false });

    expect(loadLocalPreferences(disabledHome).wakeWordEnabled).toBe(false);
  });

  it("defaults image generation to Stella", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).imageGeneration).toEqual({
      provider: "stella",
    });
  });

  it("drops the legacy Stella default model from saved model preferences", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      defaultModels: {
        orchestrator: "stella/default",
        explore: " stella/light ",
      },
      modelOverrides: {
        orchestrator: "stella/default",
        general: " stella/standard ",
        empty: " ",
      },
    });

    expect(loadLocalPreferences(stellaDataDir).defaultModels).toEqual({
      explore: "stella/light",
    });
    expect(loadLocalPreferences(stellaDataDir).modelOverrides).toEqual({
      general: "stella/standard",
    });

    const saved = updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        orchestrator: "stella/default",
        general: "stella/standard",
      },
    });
    expect(saved.modelOverrides).toEqual({ general: "stella/standard" });
  });

  it("drops retired direct-provider assistant selections without changing fal image settings", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      defaultModels: {
        orchestrator: "groq/compound",
        general: "mistral/mistral-large-latest",
      },
      modelOverrides: {
        orchestrator: "fal/assistant-model",
        explore: "openai/gpt-5.5",
      },
      imageGeneration: {
        provider: "fal",
        model: "fal/openai/gpt-image-2",
      },
    });

    const loaded = loadLocalPreferences(stellaDataDir);
    expect(loaded.defaultModels).toEqual({});
    expect(loaded.modelOverrides).toEqual({ explore: "openai/gpt-5.5" });
    expect(loaded.imageGeneration).toEqual({
      provider: "fal",
      model: "fal/openai/gpt-image-2",
    });
  });

  it("normalizes direct image provider preferences", () => {
    expect(
      normalizeImageGenerationPreferences({
        provider: "openai",
        model: " openai/gpt-image-1.5 ",
      }),
    ).toEqual({
      provider: "openai",
      model: "openai/gpt-image-1.5",
    });
    expect(
      normalizeImageGenerationPreferences({
        provider: "unknown",
        model: "openai/gpt-image-1.5",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("saves image generation in the model preference snapshot", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      imageGeneration: {
        provider: "fal",
        model: "fal/openai/gpt-image-2",
      },
    });

    expect(saved.imageGeneration).toEqual({
      provider: "fal",
      model: "fal/openai/gpt-image-2",
    });
    expect(loadLocalPreferences(stellaDataDir).imageGeneration).toEqual(
      saved.imageGeneration,
    );
  });

  it("preserves the Codex runtime engine preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      agentRuntimeEngine: "codex_cli",
    });

    expect(saved.agentRuntimeEngine).toBe("codex_cli");
    expect(loadLocalPreferences(stellaDataDir).agentRuntimeEngine).toBe(
      "codex_cli",
    );
  });

  it("preserves the Codex model preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      codexModel: "custom-codex-model",
    });

    expect(saved.codexModel).toBe("custom-codex-model");
    expect(loadLocalPreferences(stellaDataDir).codexModel).toBe(
      "custom-codex-model",
    );
  });

  it("migrates retired ChatGPT OAuth routes without changing native Codex ids", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {
      codexModel: "gpt-5.3-codex",
      defaultModels: {
        orchestrator: "openai-codex/gpt-5.2",
      },
      modelOverrides: {
        general: "openai-codex/gpt-5.1-codex-max",
        explore: "openai-codex/custom-codex-model",
      },
    });

    const loaded = loadLocalPreferences(stellaDataDir);
    expect(loaded.codexModel).toBe("gpt-5.3-codex");
    expect(loaded.defaultModels).toEqual({
      orchestrator: "openai-codex/gpt-5.6-sol",
    });
    expect(loaded.modelOverrides).toEqual({
      general: "openai-codex/gpt-5.6-sol",
      explore: "openai-codex/custom-codex-model",
    });
  });

  it("preserves the Codex reasoning preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      codexReasoningEffort: "high",
    });

    expect(saved.codexReasoningEffort).toBe("high");
    expect(loadLocalPreferences(stellaDataDir).codexReasoningEffort).toBe(
      "high",
    );
  });

  it("preserves the Claude Code model preference", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      claudeCodeModel: "sonnet[1m]",
    });

    expect(saved.claudeCodeModel).toBe("sonnet[1m]");
    expect(loadLocalPreferences(stellaDataDir).claudeCodeModel).toBe(
      "sonnet[1m]",
    );
  });

  it("defaults realtime voice to Stella", () => {
    const stellaDataDir = makeStellaDataDir();
    writePreferences(stellaDataDir, {});

    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual({
      provider: "stella",
    });
  });

  it("normalizes direct realtime voice preferences", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "openai",
        model: " openai/gpt-realtime ",
      }),
    ).toEqual({
      provider: "openai",
      model: "openai/gpt-realtime",
    });
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "xai",
        model: " grok-voice-think-fast-1.0 ",
      }),
    ).toEqual({
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
    });
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "fal",
        model: "openai/gpt-realtime",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("saves realtime voice in the model preference snapshot", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "openai",
        model: "openai/gpt-realtime",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "openai",
      model: "openai/gpt-realtime",
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );
  });

  it("preserves per-provider voice ids and resolves them by underlying provider", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "xai",
        voices: { openai: "verse", xai: "rex" },
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "xai",
      voices: { openai: "verse", xai: "rex" },
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    // Resolver picks per underlying provider — stella mode (which mints
    // openai tokens) reads `openai`, xai mode reads `xai`.
    expect(
      resolveRealtimeVoiceId(saved.realtimeVoice, "openai", "marin"),
    ).toEqual("verse");
    expect(resolveRealtimeVoiceId(saved.realtimeVoice, "xai", "eve")).toEqual(
      "rex",
    );

    // Falls back when no voice stored for that provider.
    expect(
      resolveRealtimeVoiceId(
        { provider: "stella", voices: { xai: "rex" } },
        "openai",
        "marin",
      ),
    ).toEqual("marin");
  });

  it("drops invalid voice entries on normalize but keeps valid ones", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        voices: { openai: " marin ", xai: "", extra: "ignored" },
      }),
    ).toEqual({
      provider: "stella",
      voices: { openai: "marin" },
    });
  });

  it("persists stellaSubProvider and resolves the underlying provider", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "stella",
        voices: { openai: "verse", xai: "rex" },
        stellaSubProvider: "xai",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      voices: { openai: "verse", xai: "rex" },
      stellaSubProvider: "xai",
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    expect(resolveRealtimeUnderlyingProvider(saved.realtimeVoice)).toEqual(
      "xai",
    );
    expect(resolveRealtimeUnderlyingProvider({ provider: "stella" })).toEqual(
      "openai",
    );
    expect(
      resolveRealtimeUnderlyingProvider({
        provider: "openai",
        stellaSubProvider: "xai",
      }),
    ).toEqual("openai"); // BYOK modes ignore stellaSubProvider
    expect(resolveRealtimeUnderlyingProvider({ provider: "xai" })).toEqual(
      "xai",
    );
  });

  it("drops invalid stellaSubProvider values", () => {
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        stellaSubProvider: "garbage",
      }),
    ).toEqual({ provider: "stella" });
  });

  it("detects provider route changes that require a fresh warm session", () => {
    expect(
      hasRealtimeVoiceSessionRouteChanged(
        { provider: "stella", stellaSubProvider: "openai" },
        { provider: "stella", stellaSubProvider: "inworld" },
      ),
    ).toBe(true);
    expect(
      hasRealtimeVoiceSessionRouteChanged(
        { provider: "stella", stellaSubProvider: "xai" },
        { provider: "xai" },
      ),
    ).toBe(true);
    expect(
      hasRealtimeVoiceSessionRouteChanged(
        { provider: "xai", stellaSubProvider: "openai" },
        { provider: "xai", stellaSubProvider: "inworld" },
      ),
    ).toBe(false);
    expect(
      hasRealtimeVoiceSessionRouteChanged(
        { provider: "stella", stellaSubProvider: "inworld" },
        { provider: "stella", stellaSubProvider: "inworld" },
      ),
    ).toBe(false);
  });

  it("clamps and persists inworldSpeed", () => {
    const stellaDataDir = makeStellaDataDir();

    // In-range values round-trip unchanged.
    let saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: { provider: "stella", inworldSpeed: 1.25 },
    });
    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      inworldSpeed: 1.25,
    });

    // Below range → clamped to 0.5.
    saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: { provider: "stella", inworldSpeed: 0.1 },
    });
    expect(saved.realtimeVoice.inworldSpeed).toEqual(0.5);

    // Above range → clamped to 2.0.
    saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: { provider: "stella", inworldSpeed: 5 },
    });
    expect(saved.realtimeVoice.inworldSpeed).toEqual(2.0);

    // Non-numeric → dropped silently.
    expect(
      normalizeRealtimeVoicePreferences({
        provider: "stella",
        inworldSpeed: "fast" as unknown as number,
      }),
    ).toEqual({ provider: "stella" });
  });

  it("persists Inworld provider + voices + stellaSubProvider", () => {
    const stellaDataDir = makeStellaDataDir();

    const saved = updateLocalModelPreferences(stellaDataDir, {
      realtimeVoice: {
        provider: "stella",
        voices: { openai: "marin", xai: "rex", inworld: "Sarah" },
        stellaSubProvider: "inworld",
      },
    });

    expect(saved.realtimeVoice).toEqual({
      provider: "stella",
      voices: { openai: "marin", xai: "rex", inworld: "Sarah" },
      stellaSubProvider: "inworld",
    });
    expect(loadLocalPreferences(stellaDataDir).realtimeVoice).toEqual(
      saved.realtimeVoice,
    );

    expect(resolveRealtimeUnderlyingProvider(saved.realtimeVoice)).toEqual(
      "inworld",
    );
    expect(
      resolveRealtimeVoiceId(saved.realtimeVoice, "inworld", "Clive"),
    ).toEqual("Sarah");

    // Inworld BYOK mode pins to inworld regardless of stellaSubProvider.
    expect(
      resolveRealtimeUnderlyingProvider({
        provider: "inworld",
        stellaSubProvider: "openai",
      }),
    ).toEqual("inworld");
  });
});
