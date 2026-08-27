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

    expect(AURORA_STAR_SPIN_FRAGMENT.includes("#version")).toBe(false);
    expect(/^\s*(in|out|flat)\s/m.test(AURORA_STAR_SPIN_FRAGMENT)).toBe(false);
    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("precision mediump float;");
    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("gl_FragColor");

    expect(AURORA_STAR_SPIN_FRAGMENT).toContain("#define STAR_SPIN 1");
  });
});
