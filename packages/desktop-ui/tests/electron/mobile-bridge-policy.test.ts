import { describe, expect, it } from "vitest";
import {
  MOBILE_BRIDGE_CAPABILITIES,
  MOBILE_BRIDGE_EVENT_CAPABILITIES,
  MOBILE_BRIDGE_REQUEST_CAPABILITIES,
} from "@stella/desktop/electron/services/mobile-bridge/capabilities.js";
import {
  containsPrivateChatData,
  isMobileBridgeEventChannel,
  isMobileBridgeRequestChannel,
} from "@stella/desktop/electron/services/mobile-bridge/bridge-policy.js";

describe("mobile bridge policy", () => {
  it("blocks private history events, request arguments, and local tab titles", () => {
    expect(containsPrivateChatData([{ conversationId: "local_secret", text: "private" }])).toBe(true);
    expect(containsPrivateChatData({ "stella.conversationTabs.v2:local": "private titles" })).toBe(true);
    expect(containsPrivateChatData({ conversationId: "cloud-id", text: "cloud message" })).toBe(false);
  });

  it("derives bridge channel access from explicit mobile capability decisions", () => {
    expect(isMobileBridgeRequestChannel("agent:sendInput")).toBe(true);
    expect(isMobileBridgeRequestChannel("display:readFile")).toBe(true);
    expect(isMobileBridgeRequestChannel("officePreview:list")).toBe(true);
    expect(isMobileBridgeRequestChannel("officePreview:start")).toBe(true);
    expect(isMobileBridgeEventChannel("officePreview:update")).toBe(false);
    expect(isMobileBridgeRequestChannel("devtest:triggerViteError")).toBe(
      false,
    );
    expect(
      MOBILE_BRIDGE_REQUEST_CAPABILITIES.some(
        (capability) =>
          capability.path === "agent.sendInput" &&
          capability.channel === "agent:sendInput",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_EVENT_CAPABILITIES.some(
        (capability) =>
          capability.path === "agent.onStream" &&
          capability.channel === "agent:event",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "system.openExternal" &&
          capability.mode === "native",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "display.readFile" &&
          capability.mode === "remote-request" &&
          capability.channel === "display:readFile",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "officePreview.onUpdate" &&
          capability.mode === "noop",
      ),
    ).toBe(true);
  });
});
