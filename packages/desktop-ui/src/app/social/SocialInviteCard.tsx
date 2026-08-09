import { api } from "@/convex/api";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { Avatar } from "@/ui/avatar";
import { UserPlus, Users } from "@/ui/icons";
import { useT, useTPlural } from "@/shared/i18n";
import { setPendingSocialInvite } from "@/global/social/social-invite-store";
import type { SocialInvite } from "./invite-links";
import "./social.css";

/**
 * Only the two social kinds render as invite cards. Store links never
 * reach this component: a whole-body `stella://store/...` message is
 * claimed by `parseShareLink` → `AddonShareCard` first.
 */
type SocialChatInvite = Exclude<SocialInvite, { kind: "view-store-package" }>;

type SocialInviteCardProps = {
  invite: SocialChatInvite;
};

const INVITE_CARD_CACHE_TTL_MS = 5 * 60 * 1000;

type CommunityPreview = {
  name: string;
  memberCount: number;
  memberCountTruncated: boolean;
} | null;

type FriendPreview = {
  username: string;
  avatarUrl?: string;
} | null;

/**
 * Embedded card rendered in social chat when a message body is exactly a
 * community or friend invite link. Clicking opens the same confirmation
 * dialog the OS deep link does (via the pending-invite store) — nothing
 * happens without an explicit confirm.
 */
export function SocialInviteCard({ invite }: SocialInviteCardProps) {
  const t = useT();
  const tPlural = useTPlural();
  const isJoin = invite.kind === "join-community";

  // One-shot with TTL, matching AddonShareCard: cards can appear many
  // times per conversation and invite metadata barely moves while a user
  // is reading.
  const communityPreview = usePersistentConvexOneShot(
    api.social.communities.getCommunityPreviewByInviteCode,
    isJoin ? { inviteCode: invite.inviteCode } : "skip",
    {
      scope: "public",
      ttlMs: INVITE_CARD_CACHE_TTL_MS,
    },
  ) as CommunityPreview | undefined;

  const friendPreview = usePersistentConvexOneShot(
    api.social.profiles.getProfileByUsername,
    !isJoin ? { username: invite.username } : "skip",
    {
      scope: "public",
      ttlMs: INVITE_CARD_CACHE_TTL_MS,
    },
  ) as FriendPreview | undefined;

  const eyebrow = isJoin
    ? t("app.social.inviteCard.communityEyebrow")
    : t("app.social.inviteCard.friendEyebrow");
  const loading = isJoin
    ? communityPreview === undefined
    : friendPreview === undefined;
  const missing = !loading && (isJoin ? !communityPreview : !friendPreview);

  const name = isJoin
    ? (communityPreview?.name ??
      t("app.social.inviteCard.defaultCommunityName"))
    : friendPreview
      ? `@${friendPreview.username}`
      : t("app.social.inviteCard.defaultUserName");
  const detail = isJoin
    ? communityPreview
      ? // The rendered number carries a "+" when the server truncated the
        // roster, so it goes in as `{countLabel}`; the raw count still
        // drives which plural form we pick.
        tPlural(
          "app.social.inviteCard.communityDetail",
          communityPreview.memberCount,
          {
            countLabel: `${communityPreview.memberCount}${
              communityPreview.memberCountTruncated ? "+" : ""
            }`,
          },
        )
      : ""
    : t("app.social.inviteCard.friendDetail");

  if (loading) {
    return (
      <div className="social-invite-card" data-loading>
        <div className="social-invite-card-art" />
        <div className="social-invite-card-body">
          <div className="social-invite-card-eyebrow">{eyebrow}</div>
          <div className="social-invite-card-line" />
        </div>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="social-invite-card" data-missing>
        <div className="social-invite-card-art social-invite-card-art--icon">
          {isJoin ? <Users size={18} /> : <UserPlus size={18} />}
        </div>
        <div className="social-invite-card-body">
          <div className="social-invite-card-eyebrow">{eyebrow}</div>
          <div className="social-invite-card-name">
            {isJoin
              ? t("app.social.inviteCard.inviteUnavailable")
              : t("app.social.inviteCard.userNotFound")}
          </div>
          <div className="social-invite-card-detail">
            {isJoin
              ? t("app.social.inviteCard.communityMissing")
              : t("app.social.inviteCard.userMissing")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="social-invite-card"
      onClick={() => setPendingSocialInvite(invite)}
    >
      {!isJoin && friendPreview ? (
        <Avatar
          fallback={friendPreview.username}
          src={friendPreview.avatarUrl}
          size="normal"
        />
      ) : (
        <div className="social-invite-card-art social-invite-card-art--icon">
          <Users size={18} />
        </div>
      )}
      <div className="social-invite-card-body">
        <div className="social-invite-card-eyebrow">{eyebrow}</div>
        <div className="social-invite-card-name">{name}</div>
        {detail ? (
          <div className="social-invite-card-detail">{detail}</div>
        ) : null}
      </div>
    </button>
  );
}
