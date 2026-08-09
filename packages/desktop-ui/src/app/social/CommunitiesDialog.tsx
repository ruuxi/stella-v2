import { useState, useCallback } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { useT, useTPlural } from "@/shared/i18n";
import { TextField } from "@/ui/text-field";
import { Avatar } from "@/ui/avatar";
import { ChevronLeft } from "@/ui/icons";
import { useSocialCommunities } from "./hooks/use-social-communities";
import { buildCommunityInviteLink } from "./invite-links";
import type { SocialRoomSummary } from "./hooks/use-social-rooms";
import { getSocialActionErrorMessage } from "./social-errors";

type CommunitiesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOwnerId: string;
  onOpenRoom: (roomId: string) => void;
};

type StatusMessage = {
  type: "success" | "error";
  text: string;
};

/** "ABCD-EFGH" reads better than a raw 8-char run. */
function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function CommunitiesDialog({
  open,
  onOpenChange,
  currentOwnerId,
  onOpenRoom,
}: CommunitiesDialogProps) {
  const t = useT();
  const tPlural = useTPlural();
  const {
    communities,
    createCommunity,
    joinCommunity,
    renameCommunity,
    removeCommunityMember,
    leaveCommunity,
    deleteCommunity,
  } = useSocialCommunities();

  const [nameInput, setNameInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);

  const managed =
    managedRoomId === null
      ? null
      : (communities.find((entry) => entry.room._id === managedRoomId) ?? null);

  const resetTransient = useCallback(() => {
    setStatus(null);
    setManagedRoomId(null);
    setNameInput("");
    setCodeInput("");
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetTransient();
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetTransient],
  );

  const runAction = useCallback(
    async (fallbackError: string, action: () => Promise<unknown>) => {
      setBusy(true);
      setStatus(null);
      try {
        await action();
        return true;
      } catch (error) {
        setStatus({
          type: "error",
          text: getSocialActionErrorMessage(fallbackError, error),
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleCreate = useCallback(async () => {
    const name = nameInput.trim();
    if (!name) return;
    const ok = await runAction(
      t("app.social.communities.errors.create"),
      async () => {
        await createCommunity(name);
      },
    );
    if (ok) {
      setNameInput("");
      setStatus({
        type: "success",
        text: t("app.social.communities.created", { name }),
      });
    }
  }, [nameInput, createCommunity, runAction, t]);

  const handleJoin = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) return;
    const ok = await runAction(
      t("app.social.communities.errors.join"),
      async () => {
        await joinCommunity(code);
      },
    );
    if (ok) {
      setCodeInput("");
      setStatus({
        type: "success",
        text: t("app.social.communities.joined"),
      });
    }
  }, [codeInput, joinCommunity, runAction, t]);

  const handleOpenChat = useCallback(
    (roomId: string) => {
      onOpenRoom(roomId);
      handleOpenChange(false);
    },
    [onOpenRoom, handleOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{t("app.social.communities.title")}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            {t("app.social.communities.description")}
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          {managed ? (
            <CommunityManagePane
              community={managed}
              currentOwnerId={currentOwnerId}
              busy={busy}
              status={status}
              setStatus={setStatus}
              runAction={runAction}
              onBack={() => {
                setManagedRoomId(null);
                setStatus(null);
              }}
              onClosed={() => setManagedRoomId(null)}
              onOpenChat={handleOpenChat}
              renameCommunity={renameCommunity}
              removeCommunityMember={removeCommunityMember}
              leaveCommunity={leaveCommunity}
              deleteCommunity={deleteCommunity}
            />
          ) : (
            <>
              <header className="friends-dialog-header">
                <p className="friends-dialog-title">
                  {t("app.social.communities.title")}
                </p>
                <p className="friends-dialog-sub">
                  {t("app.social.communities.subtitle")}
                </p>
              </header>

              <form
                className="friends-add-section"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreate();
                }}
              >
                <TextField
                  label={t("app.social.communities.createLabel")}
                  hideLabel
                  placeholder={t("app.social.communities.createPlaceholder")}
                  value={nameInput}
                  maxLength={80}
                  onChange={(e) => {
                    setNameInput((e.target as HTMLInputElement).value);
                    setStatus(null);
                  }}
                />
                <button
                  type="submit"
                  className="pill-btn pill-btn--primary pill-btn--lg friends-add-button"
                  disabled={!nameInput.trim() || busy}
                >
                  {t("app.social.communities.create")}
                </button>
              </form>

              <form
                className="friends-add-section"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleJoin();
                }}
              >
                <TextField
                  label={t("app.social.communities.joinLabel")}
                  hideLabel
                  placeholder={t("app.social.communities.joinPlaceholder")}
                  value={codeInput}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setCodeInput((e.target as HTMLInputElement).value);
                    setStatus(null);
                  }}
                />
                <button
                  type="submit"
                  className="pill-btn pill-btn--lg friends-add-button"
                  disabled={!codeInput.trim() || busy}
                >
                  {t("app.social.communities.join")}
                </button>
              </form>

              {status ? (
                <div className="friends-status-message" data-type={status.type}>
                  {status.text}
                </div>
              ) : null}

              <section className="friends-section">
                <div className="friends-section-label">
                  {communities.length > 0
                    ? t("app.social.communities.yourCommunitiesCount", {
                        count: communities.length,
                      })
                    : t("app.social.communities.yourCommunities")}
                </div>
                {communities.length === 0 ? (
                  <div className="friends-empty">
                    {t("app.social.communities.empty")}
                  </div>
                ) : (
                  <div className="friends-list">
                    {communities.map((community) => {
                      const name =
                        community.room.title ??
                        t("app.social.communities.defaultName");
                      const memberCount = community.memberProfiles.length;
                      return (
                        <div key={community.room._id} className="friends-item">
                          <Avatar fallback={name} size="normal" />
                          <div className="friends-item-info">
                            <div className="friends-item-name">{name}</div>
                            <div className="friends-item-tag">
                              {tPlural(
                                "app.social.communities.memberCount",
                                memberCount,
                              )}
                              {community.membership.role === "owner"
                                ? t("app.social.communities.createdByYouSuffix")
                                : ""}
                            </div>
                          </div>
                          <div className="friends-item-actions">
                            <button
                              type="button"
                              className="pill-btn"
                              onClick={() => handleOpenChat(community.room._id)}
                            >
                              {t("app.social.communities.open")}
                            </button>
                            <button
                              type="button"
                              className="pill-btn"
                              onClick={() => {
                                setManagedRoomId(community.room._id);
                                setStatus(null);
                              }}
                            >
                              {t("app.social.communities.details")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type CommunityManagePaneProps = {
  community: SocialRoomSummary;
  currentOwnerId: string;
  busy: boolean;
  status: StatusMessage | null;
  setStatus: (status: StatusMessage | null) => void;
  runAction: (
    fallbackError: string,
    action: () => Promise<unknown>,
  ) => Promise<boolean>;
  onBack: () => void;
  onClosed: () => void;
  onOpenChat: (roomId: string) => void;
  renameCommunity: (roomId: string, name: string) => Promise<unknown>;
  removeCommunityMember: (
    roomId: string,
    memberOwnerId: string,
  ) => Promise<unknown>;
  leaveCommunity: (roomId: string) => Promise<unknown>;
  deleteCommunity: (roomId: string) => Promise<unknown>;
};

function CommunityManagePane({
  community,
  currentOwnerId,
  busy,
  status,
  setStatus,
  runAction,
  onBack,
  onClosed,
  onOpenChat,
  renameCommunity,
  removeCommunityMember,
  leaveCommunity,
  deleteCommunity,
}: CommunityManagePaneProps) {
  const t = useT();
  const roomId = community.room._id;
  const name = community.room.title ?? t("app.social.communities.defaultName");
  const isCreator = community.membership.role === "owner";
  const inviteCode = community.room.inviteCode;

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [confirmingDanger, setConfirmingDanger] = useState(false);
  const [pendingMemberOwnerId, setPendingMemberOwnerId] = useState<
    string | null
  >(null);

  const handleCopy = useCallback(
    (what: "code" | "link") => {
      if (!inviteCode) return;
      void navigator.clipboard.writeText(
        what === "code"
          ? formatInviteCode(inviteCode)
          : buildCommunityInviteLink(inviteCode),
      );
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    },
    [inviteCode],
  );

  const handleRename = useCallback(async () => {
    const nextName = nameInput.trim();
    if (!nextName || nextName === name) {
      setEditingName(false);
      return;
    }
    const ok = await runAction(
      t("app.social.communities.errors.rename"),
      async () => {
        await renameCommunity(roomId, nextName);
      },
    );
    if (ok) setEditingName(false);
  }, [nameInput, name, roomId, renameCommunity, runAction, t]);

  const handleRemoveMember = useCallback(
    async (memberOwnerId: string) => {
      setPendingMemberOwnerId(memberOwnerId);
      await runAction(
        t("app.social.communities.errors.removeMember"),
        async () => {
          await removeCommunityMember(roomId, memberOwnerId);
        },
      );
      setPendingMemberOwnerId(null);
    },
    [roomId, removeCommunityMember, runAction, t],
  );

  const handleDanger = useCallback(async () => {
    if (!confirmingDanger) {
      setConfirmingDanger(true);
      return;
    }
    const ok = await runAction(
      isCreator
        ? t("app.social.communities.errors.delete")
        : t("app.social.communities.errors.leave"),
      async () => {
        if (isCreator) {
          await deleteCommunity(roomId);
        } else {
          await leaveCommunity(roomId);
        }
      },
    );
    setConfirmingDanger(false);
    if (ok) onClosed();
  }, [
    confirmingDanger,
    isCreator,
    roomId,
    deleteCommunity,
    leaveCommunity,
    runAction,
    onClosed,
    t,
  ]);

  return (
    <>
      <header className="friends-dialog-header communities-manage-header">
        <button
          type="button"
          className="pill-btn communities-back-button"
          onClick={onBack}
          disabled={busy}
        >
          <ChevronLeft size={14} aria-hidden />
          {t("app.social.communities.back")}
        </button>
        {editingName ? (
          <form
            className="friends-add-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRename();
            }}
          >
            <TextField
              label={t("app.social.communities.nameLabel")}
              hideLabel
              placeholder={t("app.social.communities.nameLabel")}
              value={nameInput}
              maxLength={80}
              autoFocus
              onChange={(e) => {
                setNameInput((e.target as HTMLInputElement).value);
                setStatus(null);
              }}
            />
            <button
              type="submit"
              className="pill-btn pill-btn--primary friends-add-button"
              disabled={!nameInput.trim() || busy}
            >
              {t("app.social.communities.save")}
            </button>
            <button
              type="button"
              className="pill-btn friends-add-button"
              onClick={() => {
                setEditingName(false);
                setNameInput(name);
              }}
              disabled={busy}
            >
              {t("app.social.communities.cancel")}
            </button>
          </form>
        ) : (
          <>
            <p className="friends-dialog-title">{name}</p>
            <p className="friends-dialog-sub">
              {isCreator
                ? t("app.social.communities.createdByYou")
                : t("app.social.communities.memberOf")}
            </p>
          </>
        )}
      </header>

      {inviteCode ? (
        <div className="friends-code-card">
          <div className="friends-code-card-info">
            <span className="friends-section-label">
              {t("app.social.communities.inviteCode")}
            </span>
            <span className="friends-code-card-value">
              {formatInviteCode(inviteCode)}
            </span>
          </div>
          <div className="friends-item-actions">
            <button
              type="button"
              className="pill-btn"
              onClick={() => handleCopy("code")}
            >
              {copied === "code"
                ? t("app.social.communities.copied")
                : t("app.social.communities.copyCode")}
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              title={t("app.social.communities.copyInviteLinkTitle")}
              onClick={() => handleCopy("link")}
            >
              {copied === "link"
                ? t("app.social.communities.copied")
                : t("app.social.communities.copyInviteLink")}
            </button>
          </div>
        </div>
      ) : null}
      <p className="communities-invite-hint">
        {t("app.social.communities.inviteHint")}
      </p>

      {status ? (
        <div className="friends-status-message" data-type={status.type}>
          {status.text}
        </div>
      ) : null}

      <section className="friends-section">
        <div className="friends-section-label">
          {t("app.social.communities.membersCount", {
            count: community.memberProfiles.length,
          })}
        </div>
        <div className="friends-list">
          {community.memberProfiles.map((member) => {
            const isSelf = member.ownerId === currentOwnerId;
            const isMemberCreator =
              member.ownerId === community.room.createdByOwnerId;
            const isRemoving = pendingMemberOwnerId === member.ownerId;
            return (
              <div key={member.ownerId} className="friends-item">
                <Avatar
                  fallback={member.username}
                  src={member.avatarUrl}
                  size="normal"
                />
                <div className="friends-item-info">
                  <div className="friends-item-name">@{member.username}</div>
                  <div className="friends-item-tag">
                    {isMemberCreator
                      ? t("app.social.communities.roleCreator")
                      : t("app.social.communities.roleMember")}
                    {isSelf ? t("app.social.communities.youSuffix") : ""}
                  </div>
                </div>
                {isCreator && !isSelf ? (
                  <div className="friends-item-actions">
                    <button
                      type="button"
                      className="pill-btn pill-btn--danger"
                      disabled={busy}
                      onClick={() => void handleRemoveMember(member.ownerId)}
                    >
                      {isRemoving
                        ? t("app.social.communities.removing")
                        : t("app.social.communities.remove")}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="friends-dialog-footer communities-manage-footer">
        <button
          type="button"
          className="pill-btn pill-btn--danger"
          disabled={busy}
          onClick={() => void handleDanger()}
        >
          {isCreator
            ? confirmingDanger
              ? t("app.social.communities.confirmDelete")
              : t("app.social.communities.delete")
            : confirmingDanger
              ? t("app.social.communities.confirmLeave")
              : t("app.social.communities.leave")}
        </button>
        <span className="communities-footer-spacer" aria-hidden />
        {isCreator && !editingName ? (
          <button
            type="button"
            className="pill-btn"
            disabled={busy}
            onClick={() => {
              setNameInput(name);
              setEditingName(true);
              setConfirmingDanger(false);
            }}
          >
            {t("app.social.communities.rename")}
          </button>
        ) : null}
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          onClick={() => onOpenChat(roomId)}
        >
          {t("app.social.communities.openChat")}
        </button>
      </div>
    </>
  );
}
