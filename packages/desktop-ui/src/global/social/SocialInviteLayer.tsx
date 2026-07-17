import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { api } from "@/convex/api";
import { router } from "@/router";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { parseSocialInviteLink } from "@/app/social/invite-links";
import { getSocialActionErrorMessage } from "@/app/social/social-errors";
import {
  setPendingSocialInvite,
  usePendingSocialInvite,
} from "./social-invite-store";
import "@/app/social/social.css";

type CommunityPreview = {
  name: string;
  memberCount: number;
  memberCountTruncated: boolean;
  alreadyMember: boolean;
} | null;

type FriendPreview = {
  username: string;
  avatarUrl?: string;
} | null;

/**
 * Global consumer for social invite links (`stella://join/<code>`,
 * `stella://add-friend/<username>` and their `https://stella.sh/...`
 * forms). Listens for OS deep links from the main process, pulls the
 * cold-boot buffer on mount, and renders the confirmation dialog for
 * whatever `setPendingSocialInvite` provides — including in-chat invite
 * cards, which push into the same store.
 */
export function SocialInviteLayer() {
  const invite = usePendingSocialInvite();

  useEffect(() => {
    const socialApi = window.electronAPI?.system;
    if (!socialApi?.onSocialInvite) return;

    let cancelled = false;
    const applyUrl = (url: string | null) => {
      if (cancelled || !url) return;
      const parsed = parseSocialInviteLink(url);
      if (parsed) setPendingSocialInvite(parsed);
    };

    // Cold-boot pull mirrors AuthDeepLinkHandler: the argv-captured link
    // sits buffered in main until this subscription is actually live.
    void socialApi.consumePendingSocialInvite?.().then(applyUrl);
    const unsubscribe = socialApi.onSocialInvite(({ url }) => {
      applyUrl(url);
      // Main buffers every invite for cold-boot mounts and doesn't know
      // when a live broadcast landed; drain the buffer here so a later
      // layer mount (window reload, second window) doesn't replay an
      // invite that was already shown and dismissed.
      void socialApi.consumePendingSocialInvite?.();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!invite) return null;
  if (invite.kind === "view-store-package") {
    return <RetiredStoreInviteFallback />;
  }
  return (
    <SocialInviteDialog
      key={
        invite.kind === "join-community"
          ? `join:${invite.inviteCode}`
          : `friend:${invite.username}`
      }
    />
  );
}

function RetiredStoreInviteFallback() {
  useEffect(() => {
    setPendingSocialInvite(null);
    void router.navigate({ to: "/chat", replace: true }).then(() => {
      dispatchShowHome();
    });
  }, []);
  return null;
}

function SocialInviteDialog() {
  const invite = usePendingSocialInvite();
  const { hasConnectedAccount } = useAuthSessionState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const joinMutation = useMutation(api.social.communities.joinCommunity);
  const sendFriendRequestMutation = useMutation(
    api.social.relationships.sendFriendRequest,
  );

  const communityPreview = useQuery(
    api.social.communities.getCommunityPreviewByInviteCode,
    invite?.kind === "join-community" && hasConnectedAccount
      ? { inviteCode: invite.inviteCode }
      : "skip",
  ) as CommunityPreview | undefined;

  const friendPreview = useQuery(
    api.social.profiles.getProfileByUsername,
    invite?.kind === "add-friend" && hasConnectedAccount
      ? { username: invite.username }
      : "skip",
  ) as FriendPreview | undefined;

  const close = useCallback(() => {
    setPendingSocialInvite(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!invite) return;
    if (invite.kind === "view-store-package") {
      setPendingSocialInvite(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (invite.kind === "join-community") {
        await joinMutation({ inviteCode: invite.inviteCode });
        showToast({
          description: communityPreview?.name
            ? `Welcome to ${communityPreview.name}!`
            : "You joined the community!",
        });
        setPendingSocialInvite(null);
      } else {
        await sendFriendRequestMutation({ username: invite.username });
        showToast({
          description: `Friend request sent to @${invite.username}.`,
        });
        setPendingSocialInvite(null);
      }
    } catch (err) {
      setError(
        getSocialActionErrorMessage(
          invite.kind === "join-community"
            ? "Couldn't join that community. The invite may have expired."
            : "Couldn't send that friend request. Please try again.",
          err,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [invite, joinMutation, sendFriendRequestMutation, communityPreview]);

  if (!invite || invite.kind === "view-store-package") return null;

  const isJoin = invite.kind === "join-community";
  const needsAccount = !hasConnectedAccount;

  // One per-kind view selection — every kind-dependent label, message and
  // gate reads from here, so adding a kind can't leave the copy, the
  // preview gating and the confirm button disagreeing about what's shown.
  const preview = isJoin ? communityPreview : friendPreview;
  const previewLoading = preview === undefined;
  // A skipped query (signed-out join/friend) stays undefined and is
  // covered by `needsAccount`; only a resolved null means "not found".
  const previewMissing = !needsAccount && preview === null;
  const alreadyDone = isJoin && communityPreview?.alreadyMember === true;

  const copy = isJoin
    ? {
        title: "Join community",
        confirmLabel: "Join",
        sub: "You were invited to a community: a trusted circle where members share add-ons with each other.",
        missing:
          "No community was found for this invite code. Ask for a fresh link.",
      }
    : {
        title: "Add friend",
        confirmLabel: "Send friend request",
        sub: "You were invited to connect on Stella.",
        missing: "No user was found for this invite link.",
      };

  return (
    <Dialog open onOpenChange={(next) => (next ? null : close())}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{copy.title}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Confirm this invitation before anything happens.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          <header className="friends-dialog-header">
            <p className="friends-dialog-title">{copy.title}</p>
            <p className="friends-dialog-sub">{copy.sub}</p>
          </header>

          <div className="social-invite-preview">
            {needsAccount ? (
              <div className="friends-empty">
                Sign in to Stella to accept this invite.
              </div>
            ) : previewLoading ? (
              <div className="friends-empty">Looking up the invite…</div>
            ) : previewMissing ? (
              <div className="friends-empty">{copy.missing}</div>
            ) : isJoin && communityPreview ? (
              <div className="friends-item">
                <Avatar fallback={communityPreview.name} size="normal" />
                <div className="friends-item-info">
                  <div className="friends-item-name">
                    {communityPreview.name}
                  </div>
                  <div className="friends-item-tag">
                    {communityPreview.memberCount}
                    {communityPreview.memberCountTruncated ? "+" : ""}{" "}
                    {communityPreview.memberCount === 1 ? "member" : "members"}
                    {alreadyDone ? " \u00b7 you're already in" : ""}
                  </div>
                </div>
              </div>
            ) : friendPreview ? (
              <div className="friends-item">
                <Avatar
                  fallback={friendPreview.username}
                  src={friendPreview.avatarUrl}
                  size="normal"
                />
                <div className="friends-item-info">
                  <div className="friends-item-name">
                    @{friendPreview.username}
                  </div>
                  <div className="friends-item-tag">Stella user</div>
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="friends-status-message" data-type="error">
              {error}
            </div>
          ) : null}

          <div className="friends-dialog-footer">
            <button
              type="button"
              className="pill-btn pill-btn--lg"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary pill-btn--lg"
              onClick={() => void handleConfirm()}
              disabled={
                busy ||
                needsAccount ||
                previewLoading ||
                previewMissing ||
                alreadyDone
              }
            >
              {busy
                ? "Working…"
                : alreadyDone
                  ? "Already joined"
                  : copy.confirmLabel}
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
