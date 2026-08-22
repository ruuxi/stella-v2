import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_DICTATION_MODEL,
  XAI_DICTATION_MODEL,
  resolveDictationModel,
  resolveDictationProvider,
} from "./dictation";

describe("resolveDictationProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to xai when DICTATION_STT_PROVIDER is unset", () => {
    vi.stubEnv("DICTATION_STT_PROVIDER", "");
    expect(resolveDictationProvider()).toBe("xai");
  });

  it("defaults to xai for unknown values", () => {
    vi.stubEnv("DICTATION_STT_PROVIDER", "something-else");
    expect(resolveDictationProvider()).toBe("xai");
  });

  it("honours the openrouter rollback", () => {
    vi.stubEnv("DICTATION_STT_PROVIDER", "openrouter");
    expect(resolveDictationProvider()).toBe("openrouter");
  });

  it("honours the inworld rollback, case-insensitively", () => {
    vi.stubEnv("DICTATION_STT_PROVIDER", " Inworld ");
    expect(resolveDictationProvider()).toBe("inworld");
  });
});

describe("resolveDictationModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the provider default", () => {
    vi.stubEnv("DICTATION_STT_MODEL", "");
    expect(resolveDictationModel("xai")).toBe(XAI_DICTATION_MODEL);
    expect(resolveDictationModel("openrouter")).toBe(
      OPENROUTER_DICTATION_MODEL,
    );
  });

  it("prefers the DICTATION_STT_MODEL env override", () => {
    vi.stubEnv("DICTATION_STT_MODEL", "grok-stt-2.0");
    expect(resolveDictationModel("xai")).toBe("grok-stt-2.0");
  });

  it("prefers an explicit request model over the env override", () => {
    vi.stubEnv("DICTATION_STT_MODEL", "grok-stt-2.0");
    expect(resolveDictationModel("xai", "requested-model")).toBe(
      "requested-model",
    );
  });
});
