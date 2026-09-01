import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  LOCAL_CACHE_RETRY_MAX_ATTEMPTS,
  localCacheRetryDelayMs,
} from "../../../src/features/chat/hooks/local-cache-retry";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const source = (relativePath: string): string =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("cloud UI resilience boundaries", () => {
  test("remounts the complete independent sidebar composer on account change", () => {
    const chatSidebar = source("shell/ChatSidebar.tsx");
    const scopedSurfaceStart = chatSidebar.indexOf(
      "function AccountScopedChatPanelTab",
    );

    expect(scopedSurfaceStart).toBeGreaterThan(-1);
    expect(chatSidebar).toContain(
      "const { accountScope } = useCloudConversationSession()",
    );
    expect(chatSidebar).toContain("key={accountScope}");
    expect(chatSidebar).toContain(
      "ignoredOpenRequestIdRef.current = props.openRequest?.id ?? null",
    );
    expect(
      chatSidebar.indexOf("useComposerMessageState()", scopedSurfaceStart),
    ).toBeGreaterThan(scopedSurfaceStart);
    expect(
      chatSidebar.indexOf("useCapturedChatContext()", scopedSurfaceStart),
    ).toBeGreaterThan(scopedSurfaceStart);
  });

  test("keeps cloud recovery controls interactive above the empty Home overlay", () => {
    const chatColumn = source("app/chat/ChatColumn.tsx");
    const homeStatusStart = chatColumn.indexOf(
      'className="full-body-home-status"',
    );

    expect(homeStatusStart).toBeGreaterThan(-1);
    expect(
      chatColumn.indexOf("{conversation.extraTail}", homeStatusStart),
    ).toBeGreaterThan(homeStatusStart);
    expect(chatColumn).toContain("inert={showHomeContent ? undefined : true}");
  });

  test("backs rebuildable local-cache reads off exponentially and then stops", () => {
    expect(
      Array.from({ length: LOCAL_CACHE_RETRY_MAX_ATTEMPTS + 1 }, (_, attempt) =>
        localCacheRetryDelayMs(attempt),
      ),
    ).toEqual([300, 600, 1_200, 2_400, 4_800, null]);

    for (const hook of [
      "features/chat/hooks/use-conversation-activity.ts",
      "features/chat/hooks/use-conversation-files.ts",
    ]) {
      const hookSource = source(hook);
      expect(hookSource).toContain("localCacheRetryDelayMs(");
      expect(hookSource).toContain("if (retryDelayMs === null) return false");
      expect(hookSource).toContain("Automatic retries stopped.");
      expect(hookSource).not.toMatch(/LOCAL_(ACTIVITY|FILES)_LOAD_RETRY_MS/);
    }
  });
});
