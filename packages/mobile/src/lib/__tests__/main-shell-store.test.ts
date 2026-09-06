import { beforeEach, describe, expect, test } from "bun:test";
import {
  publishActivityHub,
  publishComputerControl,
  readMainShellState,
  requestOpenSidebar,
  resetMainShellStore,
  subscribeSidebarOpenRequests,
  type ActivityHubData,
} from "../main-shell-store";

const hub: ActivityHubData = {
  tasks: [],
  artifacts: [],
  artifactsByTaskId: new Map(),
  conversationArtifacts: [],
  access: null,
};

describe("main shell store", () => {
  beforeEach(() => {
    resetMainShellStore();
  });

  test("starts empty so chrome renders nothing before the chat publishes", () => {
    expect(readMainShellState()).toEqual({ activity: null, computer: null, history: null });
  });

  test("publishing replaces one slot without touching the other", () => {
    publishActivityHub(hub);
    const control = { connection: "connected" as const, label: "x", onPress() {} };
    publishComputerControl(control);
    expect(readMainShellState().activity).toBe(hub);
    expect(readMainShellState().computer).toBe(control);
    publishActivityHub(null);
    expect(readMainShellState().computer).toBe(control);
  });

  test("sidebar open requests reach every subscriber until they unsubscribe", () => {
    let calls = 0;
    const off = subscribeSidebarOpenRequests(() => {
      calls += 1;
    });
    requestOpenSidebar();
    off();
    requestOpenSidebar();
    expect(calls).toBe(1);
  });
});
