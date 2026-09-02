import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = async (relativeUrl: string): Promise<string> =>
  await readFile(resolve(import.meta.dirname, relativeUrl), "utf8");

describe("anonymous mobile Chat entry", () => {
  test("creates a Better Auth anonymous owner from the account-free action", async () => {
    const [authClient, login] = await Promise.all([
      source("../auth-client.ts"),
      source("../../../app/(auth)/login.tsx"),
    ]);

    expect(authClient).toContain("anonymousClient(),");
    expect(login).toContain("await signInMobileAnonymous()");
    expect(login.indexOf("await signInMobileAnonymous()")).toBeLessThan(
      login.indexOf("await setGuestMode(true)"),
    );
  });

  test("routes anonymous owners through the canonical Chat surface", async () => {
    const [chat, thread] = await Promise.all([
      source("../../../app/(main)/chat.tsx"),
      source("../use-cloud-canonical-chat-thread.ts"),
    ]);

    expect(chat).toContain("return <SignedInChatScreen />;");
    expect(chat).not.toContain("GuestChatSurface");
    expect(chat).not.toContain("SignInPrompt");
    expect(chat).toContain("useCloudConversationAuthority()");
    expect(chat).toContain("dictationAnonymous={anonymous}");
    expect(thread).toContain(
      '"Stella could not verify this anonymous session. Try again."',
    );
  });

  test("preserves anonymous intent after the session becomes available", async () => {
    const layout = await source("../../../app/_layout.tsx");

    expect(layout).toContain("signInMobileAnonymous()");
    expect(layout).toContain(
      "const anonymous = session.data.user?.isAnonymous === true;",
    );
    expect(layout).toContain("setGuestMode(anonymous)");
    expect(layout).toContain("if (onLogin && anonymous)");
  });
});
