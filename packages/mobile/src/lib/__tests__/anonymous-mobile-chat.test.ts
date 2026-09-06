import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = async (relativeUrl: string): Promise<string> =>
  await readFile(resolve(import.meta.dirname, relativeUrl), "utf8");

describe("anonymous mobile Chat entry", () => {
  test("creates a Better Auth anonymous owner from the account-free action", async () => {
    const [authClient, anonymousSignIn, login] = await Promise.all([
      source("../auth-client.ts"),
      source("../anonymous-sign-in.ts"),
      source("../../../app/(auth)/login.tsx"),
    ]);

    expect(authClient).toContain("anonymousClient(),");
    expect(anonymousSignIn).toContain('purpose: "anonymous-sign-in"');
    expect(anonymousSignIn).toContain("requestWithAppIntegrity");
    expect(login).toContain("await signInMobileAnonymous()");
    expect(login.indexOf("await signInMobileAnonymous()")).toBeLessThan(
      login.indexOf("await setGuestMode(result.data?.user.isAnonymous === true)"),
    );
    expect(anonymousSignIn).toContain("createAnonymousSessionStarter({");
    expect(anonymousSignIn).toContain("await authClient.getSession()");
    expect(login).not.toContain("clearMobileAuthStorage");
    expect(login).not.toContain("clearCachedToken");
    expect(login).not.toContain("clearCachedDesktopBridge");
  });

  test("sends magic links with a native app-integrity proof", async () => {
    const login = await source("../../../app/(auth)/login.tsx");

    expect(login).toContain('purpose: "magic-link"');
    expect(login).toContain("buildMagicLinkHeaders(proof)");
    expect(login).not.toContain("getMobileChallengeToken");
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

  test("keeps the connected-only cloud browser subscription off anonymous sessions", async () => {
    const [browser, chat] = await Promise.all([
      source("../cloud-browser.ts"),
      source("../../../app/(main)/chat.tsx"),
    ]);

    // cloud_browser:* refuses anonymous owners; subscribing anyway throws out
    // of render and lands on the root boot crash screen.
    expect(browser).toContain("session.data?.user?.isAnonymous !== true");
    expect(browser).toContain('useQuery(listRef, enabled ? {} : "skip")');
    expect(browser).not.toContain('isAuthenticated ? {} : "skip"');
    expect(chat).toContain(
      "<CloudBoundary resetKey={thread.conversationId}>",
    );
    expect(chat.indexOf("<CloudBoundary")).toBeLessThan(
      chat.indexOf("<CloudBrowserInterventionCard"),
    );
  });

  test("admits the anonymous conversation without the connected-only placement identity", async () => {
    const placement = await source("../execution-placement.ts");

    expect(placement).toContain('"cloud_apps:getMyCloudConversationIdentity"');
    expect(placement).not.toContain(
      "execution_placement:getMyExecutionPlacementIdentity",
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
