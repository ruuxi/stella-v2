/**
 * `aurora-shader.ts` is a hand-copied snapshot of desktop's star shader, and a
 * copy with no check on it is a copy that drifts: the previous one carried a
 * header saying "edit it THERE and re-copy", and it still shipped the retired
 * orb for some time after desktop had replaced it.
 *
 * The two platforms have no module boundary between them — mobile is a
 * standalone Expo app with no path alias into desktop-ui — so this reads the
 * desktop source directly off disk. That is deliberately the only place in
 * mobile that reaches across packages, and it reaches for a string, not for
 * behaviour.
 */
import { describe, expect, test } from "bun:test";
import { AURORA_STAR_SPIN_FRAGMENT } from "../aurora-shader";

const DESKTOP_SHADER_MODULE = new URL(
  "../../../../../desktop-ui/src/shell/aurora/shader.ts",
  import.meta.url,
).pathname;

describe("aurora shader parity", () => {
  test("matches desktop's star-spin fragment byte for byte", async () => {
    const desktop = (await import(DESKTOP_SHADER_MODULE)) as {
      getFragmentShader: (variant: string) => string;
    };
    expect(AURORA_STAR_SPIN_FRAGMENT).toBe(
      desktop.getFragmentShader("star-spin"),
    );
  });

  test("is plain GLSL ES 1.0 the expo-gl context can compile", () => {
    // No `#version` and no WebGL2-only storage qualifiers: expo-gl hands out a
    // GLES 2.0 context, where either one is a hard compile error rather than a
    // fallback, and a shader that fails to compile shows up as an empty view.
    expect(AURORA_STAR_SPIN_FRAGMENT.includes("#version")).toBe(false);
    expect(/^\s*(in|out|flat)\s/m.test(AURORA_STAR_SPIN_FRAGMENT)).toBe(false);
    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("precision mediump float;");
    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("gl_FragColor");
    // The define is what selects the spinning star over the still one; without
    // it this file would silently be onboarding's slow constant turn.
    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("#define STAR_SPIN 1");
  });
});
