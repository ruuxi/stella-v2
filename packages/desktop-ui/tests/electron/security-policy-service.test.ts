import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policyFile: undefined as string | undefined,
  showMessageBox: vi.fn(),
  ensurePrivateDir: vi.fn(),
  writePrivateFile: vi.fn(async (_path: string, content: string) => {
    mocks.policyFile = content;
  }),
  readFile: vi.fn(async () => {
    if (mocks.policyFile === undefined) {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
    return mocks.policyFile;
  }),
}));

vi.mock("fs", () => ({
  promises: {
    readFile: mocks.readFile,
  },
}));

vi.mock("@stella/runtime/kernel/home/private-fs", () => ({
  ensurePrivateDir: mocks.ensurePrivateDir,
  writePrivateFile: mocks.writePrivateFile,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

const { SecurityPolicyService } = await import(
  "@stella/desktop/electron/services/security-policy-service.js"
);

const createService = () => {
  const service = new SecurityPolicyService({
    windowManagerTarget: {
      getWindowManager: () => null,
    } as never,
  });
  service.setSecurityPolicyPath("/state/security_policy.json");
  return service;
};

const request = {
  bundleIdentifier: "Com.Example.Notes",
  displayName: "Notes",
  risk: "Can edit documents",
  warningSubtitle: "Computer Use can interact with this app.",
  allowPersistentApproval: true,
};

beforeEach(() => {
  mocks.policyFile = undefined;
  mocks.showMessageBox.mockReset();
  mocks.ensurePrivateDir.mockClear();
  mocks.writePrivateFile.mockClear();
  mocks.readFile.mockClear();
});

describe("SecurityPolicyService Computer Use app approvals", () => {
  it.each([
    { bundleIdentifier: "com.apple.finder", displayName: "Finder" },
    { bundleIdentifier: "com.apple.dock", displayName: "Dock" },
    { bundleIdentifier: "com.spotify.client", displayName: "Spotify" },
    { bundleIdentifier: "pid:4242", displayName: "Unknown App" },
    { bundleIdentifier: "Spotify.exe", displayName: "Spotify.exe" },
    { bundleIdentifier: "explorer.exe", displayName: "File Explorer" },
  ])(
    "never prompts for $displayName and always approves",
    async ({ bundleIdentifier, displayName }) => {
      mocks.showMessageBox.mockResolvedValue({
        response: 1,
        checkboxChecked: true,
      });
      const service = createService();

      await expect(
        service.ensureComputerUseAppApproval({
          ...request,
          bundleIdentifier,
          displayName,
        }),
      ).resolves.toEqual({ decision: "approved", scope: "session" });

      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.writePrivateFile).not.toHaveBeenCalled();
    },
  );

  it("ignores remembered per-app approvals and never resurfaces a prompt", async () => {
    mocks.policyFile = JSON.stringify({
      version: 2,
      approved: [],
      computerUseAppApprovals: { "com.apple.finder": true },
    });
    const service = createService();
    await service.loadPolicy();

    await expect(
      service.ensureComputerUseAppApproval({
        ...request,
        bundleIdentifier: "com.apple.finder",
        displayName: "Finder",
      }),
    ).resolves.toEqual({ decision: "approved", scope: "session" });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("loads legacy privileged-action approvals and clears stale app approvals on persist", async () => {
    mocks.policyFile = JSON.stringify({
      version: 2,
      approved: ["v1:reset-local-data", "invalid-entry"],
      computerUseAppApprovals: { "com.example.notes": true },
    });
    const service = createService();
    await service.loadPolicy();

    await expect(
      service.ensureApproval(
        "reset-local-data",
        "Reset?",
        "This deletes local data.",
      ),
    ).resolves.toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();

    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: true,
    });
    await expect(
      service.ensureApproval(
        "other-privileged-action",
        "Do something risky?",
        "This is unrelated to Computer Use.",
      ),
    ).resolves.toBe(true);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.policyFile!)).toEqual({
      version: 2,
      approved: ["v1:other-privileged-action", "v1:reset-local-data"],
      computerUseAppApprovals: {},
    });
  });

  it("still prompts for unrelated privileged actions", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 1,
      checkboxChecked: true,
    });
    const service = createService();

    await expect(
      service.ensureApproval(
        "reset-local-data",
        "Reset?",
        "This deletes local data.",
      ),
    ).resolves.toBe(false);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Reset?",
        detail: "This deletes local data.",
        checkboxLabel: "desktop.security.rememberDecision",
      }),
    );
  });
});
