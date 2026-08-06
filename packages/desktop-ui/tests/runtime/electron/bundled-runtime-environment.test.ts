import { describe, expect, it } from "vitest";

import {
  configurePackagedBunEnvironment,
  configurePackagedRuntimeEnvironment,
  resolveBundledBunPath,
  resolvePackagedRuntimePaths,
} from "@stella/desktop/electron/bundled-runtime-environment.js";

describe("packaged Bun environment", () => {
  it("resolves the Bun executable shipped by a Windows installer", () => {
    expect(
      resolveBundledBunPath("C:\\Program Files\\Stella\\resources", "win32"),
    ).toBe("C:\\Program Files\\Stella\\resources\\bin\\bun.exe");
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

describe("packaged managed runtimes", () => {
  it("resolves Windows runtimes from the application resources directory", () => {
    expect(
      resolvePackagedRuntimePaths(
        "C:\\Program Files\\Stella\\resources",
        "win32",
      ),
    ).toEqual({
      bun: "C:\\Program Files\\Stella\\resources\\bin\\bun.exe",
      gitBin:
        "C:\\Program Files\\Stella\\resources\\runtimes\\git\\cmd\\git.exe",
      gitRoot: "C:\\Program Files\\Stella\\resources\\runtimes\\git",
      node: "C:\\Program Files\\Stella\\resources\\runtimes\\node\\node.exe",
      python:
        "C:\\Program Files\\Stella\\resources\\runtimes\\python\\python.exe",
      uv: "C:\\Program Files\\Stella\\resources\\bin\\uv.exe",
    });
  });

  it("configures Windows Git, Node, Python, uv, and PATH", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\System32",
      STELLA_DATA_DIR: "C:\\Users\\Rahul\\.stella",
    };
    const runtimes = configurePackagedRuntimeEnvironment({
      resourcesPath: "C:\\Stella\\resources",
      platform: "win32",
      env,
    });

    expect(env.STELLA_BUN_PATH).toBe(runtimes.bun);
    expect(env.STELLA_GIT_BIN).toBe(runtimes.gitBin);
    expect(env.STELLA_NODE_BIN).toBe(runtimes.node);
    expect(env.STELLA_NODE_IS_ELECTRON).toBe("0");
    expect(env.STELLA_PYTHON_BIN).toBe(runtimes.python);
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(env.PIP_USER).toBe("1");
    expect(env.PYTHONUSERBASE).toBe("C:\\Users\\Rahul\\.stella\\python");
    expect(env.STELLA_UV_BIN).toBe(runtimes.uv);
    expect(env.GIT_EXEC_PATH).toContain("mingw64\\libexec\\git-core");
    expect(env.Path?.split(";")).toEqual(
      expect.arrayContaining([
        "C:\\Stella\\resources\\bin",
        "C:\\Stella\\resources\\runtimes\\git\\cmd",
        "C:\\Stella\\resources\\runtimes\\node",
        "C:\\Stella\\resources\\runtimes\\python",
        "C:\\Users\\Rahul\\.stella\\python\\Scripts",
        "C:\\Windows\\System32",
      ]),
    );
  });

  it("configures relocatable macOS runtimes", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    configurePackagedRuntimeEnvironment({
      resourcesPath: "/Applications/Stella.app/Contents/Resources",
      platform: "darwin",
      env,
    });

    expect(env.STELLA_GIT_BIN).toBe(
      "/Applications/Stella.app/Contents/Resources/runtimes/git/bin/git",
    );
    expect(env.STELLA_NODE_BIN).toBe(
      "/Applications/Stella.app/Contents/Resources/runtimes/node/bin/node",
    );
    expect(env.STELLA_PYTHON_BIN).toBe(
      "/Applications/Stella.app/Contents/Resources/runtimes/python/bin/python3",
    );
    expect(env.PATH?.split(":")[0]).toBe(
      "/Applications/Stella.app/Contents/Resources/bin",
    );
  });
});
