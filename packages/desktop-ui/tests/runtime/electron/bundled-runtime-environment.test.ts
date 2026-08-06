import { describe, expect, it } from "vitest";

import {
  configurePackagedBunEnvironment,
  resolveBundledBunPath,
} from "@stella/desktop/electron/bundled-runtime-environment.js";

describe("packaged Bun environment", () => {
  it("resolves the Bun executable shipped by a Windows installer", () => {
    expect(resolveBundledBunPath("C:\\Program Files\\Stella\\resources", "win32"))
      .toBe("C:\\Program Files\\Stella\\resources\\bin\\bun.exe");
  });

  it("sets the packaged Bun path without overriding an explicit runtime", () => {
    const packagedEnv: NodeJS.ProcessEnv = {};
    expect(
      configurePackagedBunEnvironment({
        resourcesPath: "C:\\Stella\\resources",
        platform: "win32",
        env: packagedEnv,
      }),
    ).toBe("C:\\Stella\\resources\\bin\\bun.exe");
    expect(packagedEnv.STELLA_BUN_PATH).toBe(
      "C:\\Stella\\resources\\bin\\bun.exe",
    );

    const overrideEnv = { STELLA_BUN_PATH: "D:\\tools\\bun.exe" };
    expect(
      configurePackagedBunEnvironment({
        resourcesPath: "C:\\Stella\\resources",
        platform: "win32",
        env: overrideEnv,
      }),
    ).toBe("D:\\tools\\bun.exe");
  });
});
