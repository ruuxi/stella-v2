import { describe, expect, it } from "vitest";
import { IPC_EXECUTION_ANSWER_REMOTE_REQUEST } from "@stella/contracts/desktop/ipc-channels";
import {
  MOBILE_BRIDGE_CAPABILITIES,
} from "@stella/desktop/electron/services/mobile-bridge/capabilities.js";
import {
  isMobileBridgeEventChannel,
  isMobileBridgeRequestChannel,
} from "@stella/desktop/electron/services/mobile-bridge/bridge-policy.js";

/**
 * A computer agrees to run work from the owner's other devices on its own
 * screen. The phone bridge forwards renderer IPC on behalf of a paired phone,
 * so if this channel ever entered the bridge allowlist a phone could grant
 * that agreement remotely and the on-device half of the decision would quietly
 * become a second copy of the enable button.
 *
 * The enable button is a deliberate, separate path: it is authorized by the
 * account through the backend, not by impersonating this machine's screen.
 */
describe("remote execution consent is answered on the device itself", () => {
  it("keeps the consent answer off the mobile bridge", () => {
    expect(isMobileBridgeRequestChannel(IPC_EXECUTION_ANSWER_REMOTE_REQUEST)).toBe(
      false,
    );
    expect(isMobileBridgeEventChannel(IPC_EXECUTION_ANSWER_REMOTE_REQUEST)).toBe(
      false,
    );
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.channel === IPC_EXECUTION_ANSWER_REMOTE_REQUEST,
      ),
    ).toBe(false);
  });
});
