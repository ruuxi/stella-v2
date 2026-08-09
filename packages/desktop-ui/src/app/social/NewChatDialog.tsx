import { useState, useCallback } from "react";
import { Check, UserPlus } from "@/ui/icons";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { Avatar } from "@/ui/avatar";
import { useT } from "@/shared/i18n";
import { useSocialFriends } from "./hooks/use-social-friends";

type NewChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFriend: (otherOwnerId: string) => Promise<boolean>;
  onCreateGroup: (title: string, memberOwnerIds: string[]) => Promise<boolean>;
};

export function NewChatDialog({
  open,
  onOpenChange,
  onSelectFriend,
  onCreateGroup,
}: NewChatDialogProps) {
  const t = useT();
  const { friends } = useSocialFriends();
  const [mode, setMode] = useState<"pick" | "group">("pick");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [pendingFriendId, setPendingFriendId] = useState<string | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  const handleReset = useCallback(() => {
    setMode("pick");
    setSelectedIds(new Set());
    setGroupName("");
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) handleReset();
      onOpenChange(nextOpen);
    },
    [onOpenChange, handleReset],
  );

  const toggleSelection = useCallback((ownerId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) {
        next.delete(ownerId);
      } else {
        next.add(ownerId);
      }
      return next;
    });
  }, []);

  const handleCreateGroup = useCallback(async () => {
    setIsCreatingGroup(true);
    const didCreateGroup = await onCreateGroup(
      groupName.trim() || "Group",
      [...selectedIds],
    );
    setIsCreatingGroup(false);
    if (!didCreateGroup) {
      return;
    }
    handleOpenChange(false);
  }, [selectedIds, groupName, onCreateGroup, handleOpenChange]);

  const handleSelectFriend = useCallback(
    async (otherOwnerId: string) => {
      setPendingFriendId(otherOwnerId);
      const didOpenChat = await onSelectFriend(otherOwnerId);
      setPendingFriendId(null);
      if (!didOpenChat) {
        return;
      }
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectFriend],
  );

  if (friends.length === 0) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit className="friends-dialog-content">
          <VisuallyHidden asChild>
            <DialogTitle>{t("app.social.newChat.title")}</DialogTitle>
          </VisuallyHidden>
          <VisuallyHidden asChild>
            <DialogDescription>
              {t("app.social.newChat.emptySubtitle")}
            </DialogDescription>
          </VisuallyHidden>
          <DialogCloseButton className="friends-dialog-close" />
          <DialogBody className="friends-dialog-body">
            <header className="friends-dialog-header">
              <p className="friends-dialog-title">{t("app.social.newChat.title")}</p>
              <p className="friends-dialog-sub">
                {t("app.social.newChat.emptySubtitle")}
              </p>
            </header>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  if (mode === "group") {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit className="friends-dialog-content">
          <VisuallyHidden asChild>
            <DialogTitle>{t("app.social.newChat.groupTitle")}</DialogTitle>
          </VisuallyHidden>
          <VisuallyHidden asChild>
            <DialogDescription>
              {t("app.social.newChat.groupSubtitle")}
            </DialogDescription>
          </VisuallyHidden>
          <DialogCloseButton className="friends-dialog-close" />
          <DialogBody className="friends-dialog-body">
            <header className="friends-dialog-header">
              <p className="friends-dialog-title">
                {t("app.social.newChat.groupTitle")}
              </p>
              <p className="friends-dialog-sub">
                {t("app.social.newChat.groupSubtitle")}
              </p>
            </header>

            <TextField
              label={t("app.social.newChat.groupNameLabel")}
              hideLabel
              placeholder={t("app.social.newChat.groupNamePlaceholder")}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />

            <section className="friends-section">
              <div className="friends-section-label">
                {t("app.social.newChat.members")}
              </div>
              <div className="friends-list">
                {friends.map((friend) => {
                  const isSelected = selectedIds.has(friend.profile.ownerId);
                  return (
                    <button
                      key={friend.profile.ownerId}
                      type="button"
                      className="new-chat-item"
                      data-selected={isSelected ? "true" : undefined}
                      onClick={() => toggleSelection(friend.profile.ownerId)}
                      disabled={isCreatingGroup}
                    >
                      <Avatar
                        fallback={friend.profile.username}
                        src={friend.profile.avatarUrl}
                        size="normal"
                      />
                      <span className="new-chat-item-name">
                        @{friend.profile.username}
                      </span>
                      {isSelected ? (
                        <Check
                          size={16}
                          className="new-chat-item-check"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="friends-dialog-footer">
              <button
                type="button"
                className="pill-btn pill-btn--lg"
                onClick={() => setMode("pick")}
                disabled={isCreatingGroup}
              >
                {t("app.social.newChat.back")}
              </button>
              <button
                type="button"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={selectedIds.size === 0 || isCreatingGroup}
                onClick={() => void handleCreateGroup()}
              >
                {isCreatingGroup
                  ? t("app.social.newChat.creating")
                  : t("app.social.newChat.createGroup")}
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>{t("app.social.newChat.title")}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            {t("app.social.newChat.description")}
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          <header className="friends-dialog-header">
            <p className="friends-dialog-title">{t("app.social.newChat.title")}</p>
            <p className="friends-dialog-sub">
              {t("app.social.newChat.subtitle")}
            </p>
          </header>

          <div className="new-chat-list">
            <button
              type="button"
              className="new-chat-item"
              onClick={() => setMode("group")}
            >
              <span className="new-chat-item-icon">
                <UserPlus size={16} aria-hidden />
              </span>
              <span className="new-chat-item-name">
                {t("app.social.newChat.newGroup")}
              </span>
            </button>

            <div className="friends-section-label new-chat-list-label">
              {t("app.social.newChat.friends")}
            </div>

            {friends.map((friend) => (
              <button
                key={friend.profile.ownerId}
                type="button"
                className="new-chat-item"
                disabled={pendingFriendId !== null}
                onClick={() => void handleSelectFriend(friend.profile.ownerId)}
              >
                <Avatar
                  fallback={friend.profile.username}
                  src={friend.profile.avatarUrl}
                  size="normal"
                />
                <span className="new-chat-item-name">
                  {pendingFriendId === friend.profile.ownerId
                    ? t("app.social.newChat.opening")
                    : `@${friend.profile.username}`}
                </span>
              </button>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
