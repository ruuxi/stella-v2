import { useState, useCallback, useEffect } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { useT } from "@/shared/i18n";
import { TextField } from "@/ui/text-field";
import { Avatar } from "@/ui/avatar";
import { useSocialFriends } from "./hooks/use-social-friends";
import { useSocialProfile } from "./hooks/use-social-profile";
import { buildFriendInviteLink } from "./invite-links";
import { getSocialActionErrorMessage } from "./social-errors";

type FriendsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartChat: (otherOwnerId: string) => Promise<boolean>;
};

type StatusMessage = {
  type: "success" | "error";
  text: string;
};

export function FriendsDialog({
  open,
  onOpenChange,
  onStartChat,
}: FriendsDialogProps) {
  const t = useT();
  const { profile } = useSocialProfile();
  const {
    friends,
    pendingRequests,
    sendFriendRequest,
    acceptRequest,
    declineRequest,
    markIncomingFriendRequestsSeen,
    removeFriend,
  } = useSocialFriends();

  const [usernameInput, setUsernameInput] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingChatOwnerId, setPendingChatOwnerId] = useState<string | null>(
    null,
  );
  const [pendingActionOwnerId, setPendingActionOwnerId] = useState<
    string | null
  >(null);

  const handleAddFriend = useCallback(async () => {
    const username = usernameInput.trim().replace(/^@/, "").toLowerCase();
    if (!username) return;
    setSending(true);
    setStatus(null);
    try {
      await sendFriendRequest(username);
      setStatus({ type: "success", text: t("app.social.friends.requestSent") });
      setUsernameInput("");
    } catch (err) {
      setStatus({
        type: "error",
        text: getSocialActionErrorMessage(
          t("app.social.friends.errors.sendRequest"),
          err,
        ),
      });
    } finally {
      setSending(false);
    }
  }, [usernameInput, sendFriendRequest, t]);

  const runOwnerAction = useCallback(
    async (ownerId: string, action: () => Promise<unknown>) => {
      setPendingActionOwnerId(ownerId);
      try {
        await action();
      } finally {
        setPendingActionOwnerId(null);
      }
    },
    [],
  );

  const handleStartChat = useCallback(
    async (otherOwnerId: string) => {
      setPendingChatOwnerId(otherOwnerId);
      const didOpenChat = await onStartChat(otherOwnerId);
      setPendingChatOwnerId(null);
      if (!didOpenChat) {
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange, onStartChat],
  );

  const handleCopyCode = useCallback(() => {
    if (!profile) return;
    void navigator.clipboard.writeText(`@${profile.username}`);
    setStatus({
      type: "success",
      text: t("app.social.friends.usernameCopied"),
    });
  }, [profile, t]);

  const handleCopyInviteLink = useCallback(() => {
    if (!profile) return;
    void navigator.clipboard.writeText(buildFriendInviteLink(profile.username));
    setStatus({
      type: "success",
      text: t("app.social.friends.inviteLinkCopied"),
    });
  }, [profile, t]);

  const { incoming, outgoing } = pendingRequests;

  useEffect(() => {
    if (!open) return;
    if (incoming.length === 0) return;
    void markIncomingFriendRequestsSeen().catch(() => {
      // Best-effort notification marker; the next open will retry.
    });
  }, [incoming.length, markIncomingFriendRequestsSeen, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{t("app.social.friends.title")}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            {t("app.social.friends.description")}
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          <header className="friends-dialog-header">
            <p className="friends-dialog-title">
              {t("app.social.friends.title")}
            </p>
            <p className="friends-dialog-sub">
              {t("app.social.friends.subtitle")}
            </p>
          </header>

          {profile ? (
            <div className="friends-code-card">
              <div className="friends-code-card-info">
                <span className="friends-section-label">
                  {t("app.social.friends.yourUsername")}
                </span>
                <span className="friends-code-card-value">
                  @{profile.username}
                </span>
              </div>
              <div className="friends-item-actions">
                <button
                  type="button"
                  className="pill-btn"
                  title={t("app.social.friends.copyUsernameTitle")}
                  onClick={handleCopyCode}
                >
                  {t("app.social.friends.copy")}
                </button>
                <button
                  type="button"
                  className="pill-btn pill-btn--primary"
                  title={t("app.social.friends.copyInviteLinkTitle")}
                  onClick={handleCopyInviteLink}
                >
                  {t("app.social.friends.copyInviteLink")}
                </button>
              </div>
            </div>
          ) : null}

          <form
            className="friends-add-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddFriend();
            }}
          >
            <TextField
              label={t("app.social.friends.addLabel")}
              hideLabel
              placeholder={t("app.social.friends.addPlaceholder")}
              value={usernameInput}
              onChange={(e) => {
                setUsernameInput((e.target as HTMLInputElement).value);
                setStatus(null);
              }}
            />
            <button
              type="submit"
              className="pill-btn pill-btn--primary pill-btn--lg friends-add-button"
              disabled={!usernameInput.trim() || sending}
            >
              {sending
                ? t("app.social.friends.adding")
                : t("app.social.friends.add")}
            </button>
          </form>

          {status ? (
            <div className="friends-status-message" data-type={status.type}>
              {status.text}
            </div>
          ) : null}

          {incoming.length > 0 ? (
            <section className="friends-section">
              <div className="friends-section-label">
                {t("app.social.friends.requestsCount", {
                  count: incoming.length,
                })}
              </div>
              <div className="friends-list">
                {incoming.map((request) => {
                  const ownerId = request.relationship.requesterOwnerId;
                  const isPending = pendingActionOwnerId === ownerId;
                  return (
                    <div key={ownerId} className="friends-item">
                      <Avatar
                        fallback={request.profile.username}
                        src={request.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">
                          @{request.profile.username}
                        </div>
                      </div>
                      <div className="friends-item-actions">
                        <button
                          type="button"
                          className="pill-btn pill-btn--primary"
                          disabled={isPending}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              acceptRequest(ownerId),
                            )
                          }
                        >
                          {t("app.social.friends.accept")}
                        </button>
                        <button
                          type="button"
                          className="pill-btn"
                          disabled={isPending}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              declineRequest(ownerId),
                            )
                          }
                        >
                          {t("app.social.friends.decline")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {outgoing.length > 0 ? (
            <section className="friends-section">
              <div className="friends-section-label">
                {t("app.social.friends.sent")}
              </div>
              <div className="friends-list">
                {outgoing.map((request) => (
                  <div
                    key={request.relationship.addresseeOwnerId}
                    className="friends-item"
                  >
                    <Avatar
                      fallback={request.profile.username}
                      src={request.profile.avatarUrl}
                      size="normal"
                    />
                    <div className="friends-item-info">
                      <div className="friends-item-name">
                        @{request.profile.username}
                      </div>
                      <div className="friends-item-tag">
                        {t("app.social.friends.waitingForResponse")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="friends-section">
            <div className="friends-section-label">
              {friends.length > 0
                ? t("app.social.friends.friendsCount", {
                    count: friends.length,
                  })
                : t("app.social.friends.title")}
            </div>
            {friends.length === 0 ? (
              <div className="friends-empty">
                {t("app.social.friends.empty")}
              </div>
            ) : (
              <div className="friends-list">
                {friends.map((friend) => {
                  const ownerId = friend.profile.ownerId;
                  const isOpening = pendingChatOwnerId === ownerId;
                  const isRemoving = pendingActionOwnerId === ownerId;
                  return (
                    <div key={ownerId} className="friends-item">
                      <Avatar
                        fallback={friend.profile.username}
                        src={friend.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">
                          @{friend.profile.username}
                        </div>
                      </div>
                      <div className="friends-item-actions">
                        <button
                          type="button"
                          className="pill-btn"
                          disabled={pendingChatOwnerId !== null}
                          onClick={() => void handleStartChat(ownerId)}
                        >
                          {isOpening
                            ? t("app.social.friends.opening")
                            : t("app.social.friends.message")}
                        </button>
                        <button
                          type="button"
                          className="pill-btn pill-btn--danger"
                          disabled={isRemoving}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              removeFriend(ownerId),
                            )
                          }
                        >
                          {isRemoving
                            ? t("app.social.friends.removing")
                            : t("app.social.friends.remove")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
