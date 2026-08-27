import { describe, expect, it } from "vitest";

import { TOOL_IDS } from "@stella/contracts/agent-runtime";
import { dispatchLocalTool } from "../kernel/tools/local-tool-dispatch.js";

describe("local tool dispatch boundary", () => {
  it("keeps the no-response control local", async () => {
    const result = await dispatchLocalTool(
      TOOL_IDS.NO_RESPONSE,
      {},
      {
        conversationId: "conversation-1",
      },
    );

    expect(result.handled).toBe(true);
    expect(result.handled && result.text).toBe("");
  });

  it("does not resurrect retired local Dream and file authority", async () => {
    for (const toolName of ["Read", "StrReplace", "Dream"]) {
      await expect(
        dispatchLocalTool(
          toolName,
          {},
          {
            conversationId: "conversation-1",
          },
        ),
      ).resolves.toEqual({ handled: false });
    }
  });
});
