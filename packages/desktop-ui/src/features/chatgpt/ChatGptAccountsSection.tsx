import { useCallback, useState } from "react";
import type {
  ChatGptSharedRegistration,
  EngineConnection,
  EngineSettings,
} from "@stella/contracts/backend/engines";
import type { ChatGptProfileSummary } from "@stella/contracts/chatgpt-siwc-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { cloudEnginesApi } from "@/features/cloud/cloud-engines-api";
import { EngineConnectPrompt } from "@/features/cloud/EngineConnectPrompt";
import { useEngineConnect } from "@/features/cloud/use-engine-connect";
import {
  accountInitials,
  EngineAccountHeader,
  EngineAccountRowView,
  formatPlan,
  type EngineAccountMenuItem,
  type EngineAccountPlace,
} from "@/features/cloud/EngineAccountRow";
import {
  announceChatGptPlanUse,
  ContinueWithChatGptButton,
  ManageChatGptUsageLink,
} from "./ChatGptBrand";
import { useChatGptProfiles } from "./use-chatgpt-profiles";

/**
 * Every ChatGPT account the owner has, in one list.
 *
 * Sign in with ChatGPT is per host by design: the tokens never leave the host
 * that signed in. So one account can be signed in on this computer, in the
 * owner's cloud, in both, or in neither — and the row says which. The cloud's
 * sign-in serves cloud agents; this computer's serves ChatGPT models run here.
 * Picking the row makes the account the active one wherever it is signed in.
 */

const K = "settings.engineAccounts";

const sameEmail = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

type ChatGptAccount = {
  key: string;
  title: string;
  email?: string;
  plan?: string;
  clientId?: string;
  local?: ChatGptProfileSummary;
  cloud?: EngineConnection;
};

const matches = (
  account: { clientId?: string; email?: string },
  candidate: { clientId?: string; email?: string },
) =>
  Boolean(
    (account.clientId && account.clientId === candidate.clientId) ||
      sameEmail(account.email, candidate.email),
  );

/** Cloud connections, this computer's profiles and other hosts' registrations, merged. */
function mergeAccounts(
  cloudConnections: readonly EngineConnection[],
  localProfiles: readonly ChatGptProfileSummary[],
  registrations: readonly ChatGptSharedRegistration[],
): ChatGptAccount[] {
  const accounts: ChatGptAccount[] = [];
  const add = (account: ChatGptAccount) => {
    accounts.push(account);
    return account;
  };

  for (const cloud of cloudConnections) {
    const local = localProfiles.find((profile) => matches(profile, cloud));
    add({
      key: `cloud:${cloud.accountId}`,
      title: cloud.email ?? cloud.name ?? cloud.label,
      ...(cloud.email ? { email: cloud.email } : {}),
      ...(cloud.plan ? { plan: cloud.plan } : {}),
      ...(cloud.clientId ? { clientId: cloud.clientId } : {}),
      ...(local ? { local } : {}),
      cloud,
    });
  }

  for (const local of localProfiles) {
    if (accounts.some((account) => account.local === local)) continue;
    add({
      key: `local:${local.id}`,
      title: local.email ?? local.name ?? local.label,
      ...(local.email ? { email: local.email } : {}),
      clientId: local.clientId,
      local,
    });
  }

  for (const registration of registrations) {
    if (!registration.email && !registration.name) continue;
    if (accounts.some((account) => matches(account, registration))) continue;
    add({
      key: `shared:${registration.clientId}`,
      title: registration.email ?? registration.name ?? registration.clientId,
      ...(registration.email ? { email: registration.email } : {}),
      clientId: registration.clientId,
    });
  }

  return accounts;
}

export function ChatGptAccountsSection({
  settings,
  refreshing,
  cloudAvailable,
}: {
  settings: EngineSettings | undefined;
  refreshing: boolean;
  /** The owner's cloud can hold a sign-in (they are signed in to Stella). */
  cloudAvailable: boolean;
}) {
  const t = useT();
  const chatgpt = useChatGptProfiles();
  const connect = useEngineConnect();
  const [busy, setBusy] = useState(false);
  const { signIn } = chatgpt;
  const { start } = connect;

  const errorTitle = useCallback(
    (error: unknown) =>
      error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
    [t],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await action();
        if (done) showToast({ title: done });
      } catch (error) {
        showToast({ title: errorTitle(error), variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [errorTitle],
  );

  const signInHere = useCallback(
    async (options?: {
      profileId?: string;
      sharedClientId?: string;
      enablePlanUsage?: boolean;
    }) => {
      try {
        const profile = await signIn(options);
        if (!profile) return;
        if (profile.planUsage) {
          showToast({ title: t(`${K}.chatgptComputerSignedIn`) });
          announceChatGptPlanUse();
        } else {
          showToast({
            title: t(`${K}.planUsageOffTitle`),
            description: t(`${K}.planUsageOffBody`),
          });
        }
      } catch (error) {
        showToast({ title: errorTitle(error), variant: "error" });
      }
    },
    [errorTitle, signIn, t],
  );

  const signInCloud = useCallback(
    async (options: { accountId?: string; clientId?: string; enablePlanUsage?: boolean } = {}) => {
      try {
        if (!(await start(options))) return;
        showToast({ title: t(`${K}.chatgptCloudSignedIn`) });
        announceChatGptPlanUse();
      } catch (error) {
        showToast({ title: errorTitle(error), variant: "error" });
      }
    },
    [errorTitle, start, t],
  );

  const revokeNote = (place: "cloud" | "computer", result: { revoked: boolean } | undefined | null) => {
    if (result && !result.revoked) {
      showToast({
        title: t(place === "cloud" ? `${K}.revokeTitleCloud` : `${K}.revokeTitleComputer`),
        description: t(`${K}.revokeUnconfirmed`),
      });
    }
  };

  if (!chatgpt.available && !cloudAvailable) return null;

  const cloudConnections = (settings?.connections ?? []).filter(
    (row) => row.provider === "chatgpt",
  );
  const accounts = mergeAccounts(
    cloudAvailable ? cloudConnections : [],
    chatgpt.available ? chatgpt.profiles : [],
    settings?.chatGptRegistrations ?? [],
  );
  const disabled = busy || refreshing || !chatgpt.loaded || connect.flow !== null;
  const adding = chatgpt.signingIn || connect.flow !== null;

  const statusOf = (account: ChatGptAccount): string | undefined => {
    const states = [account.local?.status, account.cloud?.status];
    if (states.includes("reauth_required")) return t(`${K}.statusReauth`);
    if (account.local?.planUsage === false || account.cloud?.planUsage === false) {
      return t(`${K}.statusPlanUsageOff`);
    }
    return undefined;
  };

  const addChatGpt = chatgpt.available ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ContinueWithChatGptButton
          label={accounts.length > 0 ? t(`${K}.addChatgpt`) : undefined}
          disabled={disabled}
          loading={adding}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12}>
        <DropdownMenuItem onSelect={() => void signInHere()}>
          {t(`${K}.addOnComputer`)}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!cloudAvailable} onSelect={() => void signInCloud()}>
          {t(`${K}.addInCloud`)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <ContinueWithChatGptButton
      label={accounts.length > 0 ? t(`${K}.addChatgptCloud`) : undefined}
      onClick={() => void signInCloud()}
      disabled={disabled}
      loading={adding}
    />
  );

  return (
    <>
      <EngineAccountHeader title={t(`${K}.chatgptTitle`)} control={addChatGpt} />
      {accounts.map((account, index) => {
        const { local, cloud } = account;
        const signedInHere = local?.status === "signed_in";
        const signedInCloud = Boolean(cloud && !cloud.status);
        const places: EngineAccountPlace[] = [
          ...(chatgpt.available
            ? [{ key: "computer", label: t(`${K}.placeComputer`), signedIn: signedInHere }]
            : []),
          ...(cloudAvailable
            ? [{ key: "cloud", label: t(`${K}.placeCloud`), signedIn: signedInCloud }]
            : []),
        ];

        const items: EngineAccountMenuItem[] = [];
        if (chatgpt.available && !signedInHere) {
          items.push({
            key: "in-here",
            label: t(`${K}.signInComputer`),
            onSelect: () =>
              void signInHere(
                local
                  ? { profileId: local.id }
                  : account.clientId
                    ? { sharedClientId: account.clientId }
                    : {},
              ),
          });
        }
        if (cloudAvailable && !signedInCloud) {
          items.push({
            key: "in-cloud",
            label: t(`${K}.signInCloud`),
            onSelect: () =>
              void signInCloud(
                cloud
                  ? { accountId: cloud.accountId }
                  : account.clientId
                    ? { clientId: account.clientId }
                    : {},
              ),
          });
        }
        if (signedInHere && local?.planUsage === false) {
          items.push({
            key: "plan-here",
            label: t(`${K}.enablePlanUsage`),
            onSelect: () => void signInHere({ profileId: local.id, enablePlanUsage: true }),
          });
        }
        if (signedInCloud && cloud?.planUsage === false) {
          items.push({
            key: "plan-cloud",
            label: t(`${K}.enablePlanUsageCloud`),
            onSelect: () =>
              void signInCloud({ accountId: cloud.accountId, enablePlanUsage: true }),
          });
        }

        const tail: EngineAccountMenuItem[] = [];
        if (local && local.status !== "signed_out") {
          tail.push({
            key: "out-here",
            label: t(`${K}.signOutComputer`),
            onSelect: () =>
              void run(
                async () => revokeNote("computer", await chatgpt.signOut(local.id)),
                t(`${K}.signedOut`),
              ),
          });
        }
        if (cloud && cloud.status !== "signed_out") {
          tail.push({
            key: "out-cloud",
            label: t(`${K}.signOutCloud`),
            onSelect: () =>
              void run(
                async () =>
                  revokeNote("cloud", await cloudEnginesApi.disconnect("chatgpt", cloud.accountId)),
                t(`${K}.signedOut`),
              ),
          });
        }
        if (local || cloud) {
          tail.push({
            key: "remove",
            label: t(`${K}.remove`),
            onSelect: () =>
              void run(async () => {
                if (local) await chatgpt.remove(local.id);
                if (cloud) {
                  await cloudEnginesApi.disconnect("chatgpt", cloud.accountId, { forget: true });
                }
              }, t(`${K}.removed`)),
          });
        }

        const usableHere = signedInHere && local?.planUsage !== false;
        const usableInCloud = signedInCloud && cloud?.planUsage !== false;
        const active =
          (!local || local.active) && (!cloud || cloud.active) && (usableHere || usableInCloud);
        const pick =
          !active && (usableHere || usableInCloud)
            ? () =>
                void run(async () => {
                  if (cloud && usableInCloud && !cloud.active) {
                    await cloudEnginesApi.setActiveAccount("chatgpt", cloud.accountId);
                  }
                  if (local && usableHere && !local.active) await chatgpt.setActive(local.id);
                })
            : undefined;
        const subtitle = [formatPlan(account.plan), statusOf(account)]
          .filter(Boolean)
          .join(" · ");

        return (
          <EngineAccountRowView
            key={account.key}
            id={account.key}
            title={account.title}
            initials={accountInitials({ label: account.title, ...(account.email ? { email: account.email } : {}) })}
            {...(subtitle ? { subtitle } : {})}
            places={places}
            active={active}
            busy={disabled}
            {...(pick ? { onPick: pick } : {})}
            items={items}
            tail={tail}
            divided={index > 0}
          />
        );
      })}
      {connect.flow ? <EngineConnectPrompt connect={connect} /> : null}
      {chatgpt.signingIn ? (
        <div className="settings-row">
          <div className="settings-row-sublabel" aria-live="polite">
            {t(`${K}.chatgptBrowserWaiting`)}
          </div>
          <div className="settings-row-control">
            <button type="button" className="pill-btn" onClick={chatgpt.cancelSignIn}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {accounts.some((account) => Boolean(account.local || account.cloud)) ? (
        <div className="settings-row">
          <div className="settings-row-control">
            <ManageChatGptUsageLink />
          </div>
        </div>
      ) : null}
    </>
  );
}
