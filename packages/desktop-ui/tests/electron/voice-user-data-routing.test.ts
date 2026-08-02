import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

describe("voice user-data routing", () => {
  it("routes voice preferences and credentials through the durable Stella home", async () => {
    const voiceHandlers = await readSource(
      "../../../desktop/electron/ipc/voice-handlers.ts",
    );

    expect(voiceHandlers).not.toContain("options.stellaAppDir");
    expect(voiceHandlers).toContain(
      "loadLocalPreferences(options.stellaDataDirPath)",
    );
    expect(voiceHandlers).toContain(
      "saveLocalPreferences(options.stellaDataDirPath, prefs)",
    );
    expect(voiceHandlers).toContain(
      "getRealtimeVoicePreferences(\n        options.stellaDataDirPath,\n      )",
    );
    expect(voiceHandlers).toContain(
      'getLocalLlmCredential(options.stellaDataDirPath, "openai")',
    );
    expect(voiceHandlers).toContain(
      'getLocalLlmOAuthApiKey(options.stellaDataDirPath, "openai")',
    );
  });

  it("does not offer the Electron app root to voice handlers", async () => {
    const bootstrapIpc = await readSource(
      "../../../desktop/electron/bootstrap/ipc.ts",
    );
    const registration = bootstrapIpc.match(
      /registerVoiceHandlers\(\{[\s\S]*?\n {2}\}\);/,
    )?.[0];

    expect(registration).toBeDefined();
    expect(registration).toContain(
      "stellaDataDirPath: state.stellaDataDirPath!",
    );
    expect(registration).not.toContain("stellaAppDir");
  });
});
