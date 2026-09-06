import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = async (relativeUrl: string): Promise<string> =>
  await readFile(resolve(import.meta.dirname, relativeUrl), "utf8");

describe("mobile Cloud Home Settings reachability", () => {
  test("mounts the editor route from the signed-in Settings surface", async () => {
    const [settingsRoute, settingsContent, deviceSheet, cloudHomeRoute] = await Promise.all([
      source("../../../app/(main)/settings.tsx"),
      source("../../components/SettingsContent.tsx"),
      source("../../components/ComputerDeviceSheet.tsx"),
      source("../../../app/(main)/cloud-home.tsx"),
    ]);

    expect(settingsRoute).toContain("<SettingsContent");
    expect(deviceSheet).toContain("<SettingsContent");
    expect(settingsContent).toContain('router.push("/cloud-home")');
    expect(settingsContent).toContain('t("mobile.cloudHome.openSettingsLabel")');
    expect(settingsContent.indexOf("{isSignedIn ? (")).toBeLessThan(
      settingsContent.indexOf('router.push("/cloud-home")'),
    );
    expect(cloudHomeRoute).toContain("<CloudHomeSettings");
    expect(cloudHomeRoute).toContain("observeCloudConversationIdentity(");
    expect(cloudHomeRoute).toContain("session.data ?? null");
    expect(cloudHomeRoute).toContain(
      'key={identity?.identityKey ?? "signed-out"}',
    );
    expect(cloudHomeRoute).toContain("identity={identity}");
    expect(cloudHomeRoute).toContain("onBack={() => router.back()}");
    expect(cloudHomeRoute).toContain('router.replace("/login")');
  });

  test("provides list, read, text edit, CAS save, conflict reload, and safe states", async () => {
    const editor = await source("../../components/CloudHomeSettings.tsx");

    expect(editor).toContain("const snapshot = await listMemory()");
    expect(editor).toContain("await readMemory(summary.name)");
    expect(editor).toContain("await writeMemory({");
    expect(editor).toContain("authority: selectedAuthority");
    expect(editor).toContain("expectedRevision: base.revision");
    expect(editor).toContain("<TextInput");
    expect(editor).toContain('t("mobile.cloudHome.conflict.title")');
    expect(editor).toContain('t("mobile.cloudHome.conflict.reload")');
    expect(editor).toContain('t("mobile.cloudHome.signInTitle")');
    expect(editor).toContain('t("mobile.cloudHome.unavailableTitle")');
    expect(editor).toContain("t(`mobile.cloudHome.errors.${error.code}`)");
    expect(editor.includes("error.message")).toBe(false);
    expect(/r2Key|manifestR2Key|objectKey/u.test(editor)).toBe(false);
  });

  test("keeps authoritative Memory preference independent from document availability", async () => {
    const [editor, preferenceHook] = await Promise.all([
      source("../../components/CloudHomeSettings.tsx"),
      source("../use-cloud-memory-preference.ts"),
    ]);

    expect(editor).toContain("useMobileCloudHome(identity)");
    expect(editor).toContain("useCloudMemoryPreference(identity)");
    expect(editor).toContain("<GlassToggle");
    expect(editor).toContain('t("settings.memory.description")');
    expect(editor.indexOf("<GlassToggle")).toBeLessThan(
      editor.indexOf("cloudHomeLoading ?"),
    );
    expect(editor).toContain("cloudHomeUnavailable ?");
    expect(editor).toContain("summaries.map((summary)");
    expect(preferenceHook).toContain("beginMobileCloudMemoryPreferenceWrite({");
    expect(preferenceHook).toContain(
      "mobileCloudMemoryPreferenceClient.write(attempt)",
    );
    expect(preferenceHook).toContain(
      "acceptCurrentMobileCloudMemoryPreferenceResult",
    );
    expect(preferenceHook).toContain("identityKey: owner.identityKey");
    expect(preferenceHook).toContain(
      "identityRevision: owner.identityRevision",
    );
    expect(preferenceHook).toContain("useConvexTokenOwner(sessionIdentity)");
    expect(preferenceHook).toContain("expectedSubject: owner.expectedSubject");
    expect(preferenceHook.includes("env.convexSiteUrl")).toBe(false);
    expect(
      preferenceHook.includes("createMobileCloudMemoryOwnerSubject("),
    ).toBe(false);
    expect(preferenceHook).toContain(
      'failedMobileCloudMemoryPreference(base, "save")',
    );
    expect(preferenceHook).toContain(
      "accepted.preference.memoryEnabled !== target",
    );
    expect(preferenceHook).toContain('kind: "reload_then_write"');
    expect(preferenceHook.includes("accepted.current")).toBe(false);
    expect(preferenceHook).toContain(
      "previousGeneration !== accepted.preference.ownerGeneration",
    );
    expect(preferenceHook).toContain(
      "ownerGeneration: preferenceRef.current?.ownerGeneration",
    );
    expect(preferenceHook).toContain("committedIdentityRef.current = identity");
    expect(preferenceHook).toContain("activeRequestIdRef.current = null");
    expect(preferenceHook).toContain("desiredValueRef.current = null");
    expect(preferenceHook).toContain("error.retryable &&");
    expect(preferenceHook).toContain("load({ thenWrite: plan.memoryEnabled })");
    expect(preferenceHook).toContain('AppState.addEventListener("change"');
  });

  test("binds document HTTP requests to the full owner subject and current session", async () => {
    const [hook, editor] = await Promise.all([
      source("../use-cloud-home.ts"),
      source("../../components/CloudHomeSettings.tsx"),
    ]);

    expect(hook).toContain("useConvexTokenOwner(identity)");
    expect(hook).toContain("expectedSubject: owner.expectedSubject");
    expect(hook.includes("env.convexSiteUrl")).toBe(false);
    expect(hook).toContain("getConvexTokenForOwner(");
    expect(hook).toContain("boundIdentity.requestIdentity.expectedSubject");
    expect(hook).toContain(
      "getCurrentIdentity: () => committedIdentityRef.current",
    );
    expect(editor).toContain("identity.accountScope");
    expect(editor).toContain("identity.identityKey");
    expect(editor).toContain("identity.revision");
    expect(editor).toContain("identityRef.current !== identityAtStart");
  });

  test("binds canonical owner-generation reads to the JWT tokenIdentifier", async () => {
    const [hook, store] = await Promise.all([
      source("../use-cloud-canonical-chat-thread.ts"),
      source("../cloud-conversation-authority-store.ts"),
    ]);

    expect(hook).toMatch(
      /getConvexTokenOwnerForSubject\(\s*identity\.expectedSubject,?\s*\)/u,
    );
    expect(hook).toContain("const ownerSubject = tokenOwner.tokenIdentifier");
    // The handshake result is process-level; a settled request for an
    // identity the store has since moved past must not publish.
    expect(store).toContain("if (generation !== this.generation) return;");
    expect(hook).toContain("new CloudConversationAuthorityStore({");
    expect(hook.includes("env.convexSiteUrl")).toBe(false);
    expect(hook.includes("createMobileCloudMemoryOwnerSubject(")).toBe(false);
  });
});
