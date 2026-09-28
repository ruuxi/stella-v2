import { beforeEach, describe, expect, test } from "bun:test";
import {
  publishActivityHub,
  publishComputerControl,
  readMainShellState,
  requestOpenSidebar,
  resetMainShellStore,
  subscribeSidebarOpenRequests,
  type ActivityHubData,
  type ComputerControl,
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

  test("publishing replaces one slot without touching the other", () => {
    publishActivityHub(hub);
    const control = { platformLabel: "x" } as ComputerControl;
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
