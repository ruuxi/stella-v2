import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { showToast } from "@/ui/toast";
import { useT, useTPlural } from "@/shared/i18n";
import { Select } from "@/ui/select";
import { Check, Store, Users } from "@/ui/icons";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { getStoreSidePanelLegacyApi } from "../store-side-panel-store";
import { Avatar } from "@/ui/avatar";
import { useSocialCommunities } from "@/app/social/hooks/use-social-communities";
import { useSocialFriends } from "@/app/social/hooks/use-social-friends";
import { useSocialProfile } from "@/app/social/hooks/use-social-profile";
import { buildShareLink } from "../share-link";
import { packageIdFromName } from "./format";
import type { StoreCategory } from "./types";

/**
 * One selected shareable change. `featureId` pins the selection to an
 * exact roster feature — display names are not unique, so without it two
 * same-named features would collapse onto whichever resolves first.
 */
export type ShareFeatureRef = {
  name: string;
  featureId?: string;
};

type ShareDialogProps = {
  open: boolean;
  selectedFeatures: ShareFeatureRef[];
  onClose: () => void;
  onShared: (args: { releaseNumber: number }) => Promise<void> | void;
};

/**
 * Where the share is headed. "circle" publishes an unlisted, instantly
 * live release and drops its share card into the chosen chats; "store"
 * submits into the Stella team's manual approval queue.
 */
type ShareDestination = "circle" | "store";

type RecipientKey = `room:${string}` | `friend:${string}`;

/**
 * Share entry point for source-backed changes. One dialog, two
 * destinations:
 *
 *  - Friends & communities — instant. The release is unlisted (link-only)
 *    and a share card lands in each selected chat immediately; no review.
 *  - Stella Store — public. The release joins the manual approval queue
 *    and goes live for everyone once the Stella team approves it.
 */
export function ShareDialog(props: ShareDialogProps) {
  // Fully unmount when closed so the social list subscriptions (friends,
  // communities) only live while the user is actually picking recipients.
  if (!props.open) return null;
  return <ShareDialogInner {...props} />;
}

function ShareDialogInner({
  selectedFeatures,
  onClose,
  onShared,
}: ShareDialogProps) {
  const t = useT();
  const tPlural = useTPlural();
  const myPackages = useConvexOneShot(
    api.data.store_packages.listMyPackages,
    {},
  );
  const { communities } = useSocialCommunities();
  const { friends } = useSocialFriends();
  const { profile, ensureProfile } = useSocialProfile();

  const sendRoomMessageMutation = useMutation(
    api.social.messages.sendRoomMessage,
  );
  const getOrCreateDmRoomMutation = useMutation(
    api.social.rooms.getOrCreateDmRoom,
  );

  const [destination, setDestination] = useState<ShareDestination | null>(null);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<StoreCategory | "">("");
  const [asUpdate, setAsUpdate] = useState(false);
  const [updatePackageId, setUpdatePackageId] = useState("");
  const [recipients, setRecipients] = useState<Set<RecipientKey>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const sourceFeatures = useMemo(() => {
    // Dedupe on featureId (falling back to name for legacy rows without
    // one) so two distinct features that happen to share a display name
    // both survive into the publish payload.
    const seen = new Set<string>();
    const features: ShareFeatureRef[] = [];
    for (const feature of selectedFeatures) {
      const name = feature.name.trim();
      if (!name) continue;
      const key = feature.featureId ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ name, featureId: feature.featureId });
    }
    return features;
  }, [selectedFeatures]);

  const selectedFeatureName =
    sourceFeatures.length === 1 ? sourceFeatures[0]!.name : "";
  const [displayName, setDisplayName] = useState(selectedFeatureName);

  const selectDestination = (next: ShareDestination | null) => {
    setDestination(next);
    setAsUpdate(false);
    setUpdatePackageId("");
  };

  const ownedPackages = (myPackages ?? []) as Array<{
    packageId: string;
    displayName: string;
    description: string;
    category?: StoreCategory;
    visibility?: "public" | "unlisted" | "private";
  }>;

  // Circle updates must stay on the no-review path, so only unlisted
  // (circle-born) packages qualify; everything else is store-reviewed.
  const updatablePackages = ownedPackages.filter((pkg) =>
    destination === "circle"
      ? pkg.visibility === "unlisted"
      : (pkg.visibility ?? "public") !== "unlisted",
  );

  const toggleRecipient = (key: RecipientKey) => {
    setRecipients((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!destination) return;
    if (sourceFeatures.length === 0) {
      showToast({
        title: t("features.store.shareDialog.noSourceChangesTitle"),
        description: t("features.store.shareDialog.noSourceChangesBody"),
        variant: "error",
      });
      return;
    }
    if (destination === "circle" && recipients.size === 0) {
      showToast({
        title: t("features.store.shareDialog.pickRecipientTitle"),
        description: t("features.store.shareDialog.pickRecipientBody"),
        variant: "error",
      });
      return;
    }

    let publishPackageId: string;
    let publishDisplayName: string;
    let publishDescription: string;
    let publishCategory: StoreCategory | undefined;

    if (asUpdate) {
      const selectedPackage = updatablePackages.find(
        (pkg) => pkg.packageId === updatePackageId.trim(),
      );
      if (!selectedPackage) {
        showToast({
          title: t("features.store.shareDialog.pickAddonTitle"),
          description: t("features.store.shareDialog.pickAddonBody"),
          variant: "error",
        });
        return;
      }
      publishPackageId = selectedPackage.packageId;
      publishDisplayName = selectedPackage.displayName;
      publishDescription = selectedPackage.description;
      publishCategory = selectedPackage.category;
    } else {
      const trimmedName = displayName.trim();
      if (!trimmedName) {
        showToast({
          title: t("features.store.shareDialog.nameRequiredTitle"),
          description: t("features.store.shareDialog.nameRequiredBody"),
          variant: "error",
        });
        return;
      }
      const slug = packageIdFromName(trimmedName);
      if (!slug) {
        showToast({
          title: t("features.store.shareDialog.badNameTitle"),
          description: t("features.store.shareDialog.badNameBody"),
          variant: "error",
        });
        return;
      }
      publishPackageId = slug;
      publishDisplayName = trimmedName;
      publishDescription = description.trim();
      publishCategory = category || undefined;
    }

    const manifest = {
      ...(publishCategory ? { category: publishCategory } : {}),
      ...(publishDescription
        ? { summary: publishDescription.slice(0, 500) }
        : {}),
    };
    const storeApi = getStoreSidePanelLegacyApi();
    const publishSelectedFeatures = storeApi?.publishSelectedFeatures;
    if (!publishSelectedFeatures) {
      showToast({
        title: t("features.store.shareDialog.shareFailedTitle"),
        description: t("features.store.shareDialog.publishBackendMissing"),
        variant: "error",
      });
      return;
    }
    const publishArgs = {
      attachedFeatureNames: sourceFeatures.map((feature) => feature.name),
      // Parallel to the names; "" marks legacy rows the worker resolves by
      // name instead.
      attachedFeatureIds: sourceFeatures.map(
        (feature) => feature.featureId ?? "",
      ),
      packageId: publishPackageId,
      asUpdate,
      manifest,
      audience: destination,
      ...(asUpdate
        ? {}
        : {
            displayName: publishDisplayName,
            ...(publishDescription ? { description: publishDescription } : {}),
            ...(publishCategory ? { category: publishCategory } : {}),
          }),
    };

    // Snapshot everything the background task needs before closing (the
    // component unmounts with the dialog).
    const toastName = publishDisplayName;
    const circleRecipients = [...recipients];
    const communityRoomsById = new Map(
      communities.map((entry) => [entry.room._id, entry] as const),
    );
    const isCircle = destination === "circle";

    setSubmitting(true);
    onClose();
    showToast({
      title: isCircle
        ? t("features.store.shareDialog.sharingTitle")
        : t("features.store.shareDialog.submittingTitle"),
      description: t("features.store.shareDialog.inProgressBody"),
    });
    void (async () => {
      try {
        // The worker resolves selected feature names to commits and a
        // source pack. Renderer input is only listing metadata plus the
        // selected source refs.
        const release = await publishSelectedFeatures(publishArgs);
        await onShared({
          releaseNumber: release.releaseNumber,
        });

        if (!isCircle) {
          showToast({
            title: t("features.store.shareDialog.submittedTitle"),
            description: t("features.store.shareDialog.submittedBody", {
              name: toastName,
            }),
          });
          return;
        }

        // Drop the share card into every selected chat. The card resolves
        // by packageId; the username segment is the author handle.
        const authorProfile = profile ?? (await ensureProfile());
        const shareLink = buildShareLink(
          authorProfile.username,
          publishPackageId,
        );
        let delivered = 0;
        let failed = 0;
        for (const key of circleRecipients) {
          try {
            let roomId: string;
            if (key.startsWith("room:")) {
              const id = key.slice("room:".length);
              if (!communityRoomsById.has(id)) continue;
              roomId = id;
            } else {
              const otherOwnerId = key.slice("friend:".length);
              const room = await getOrCreateDmRoomMutation({ otherOwnerId });
              roomId = room._id;
            }
            await sendRoomMessageMutation({ roomId, body: shareLink });
            delivered += 1;
          } catch {
            failed += 1;
          }
        }
        showToast({
          title: t("features.store.shareDialog.sharedTitle"),
          description:
            failed === 0
              ? tPlural(
                  "features.store.shareDialog.sharedBodyDelivered",
                  delivered,
                  { name: toastName },
                )
              : tPlural(
                  "features.store.shareDialog.sharedBodyPartial",
                  delivered + failed,
                  { name: toastName, delivered },
                ),
          ...(failed > 0 ? { variant: "error" as const } : {}),
        });
      } catch (error) {
        showToast({
          title: isCircle
            ? t("features.store.shareDialog.shareFailedTitle")
            : t("features.store.shareDialog.submissionFailedTitle"),
          description: (error as Error)?.message,
          variant: "error",
        });
      }
    })();
  };

  const title =
    destination === null
      ? t("features.store.shareDialog.title")
      : destination === "circle"
        ? asUpdate
          ? t("features.store.shareDialog.titleCircleUpdate")
          : t("features.store.shareDialog.titleCircle")
        : asUpdate
          ? t("features.store.shareDialog.titleStoreUpdate")
          : t("features.store.shareDialog.titleStore");

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent fit className="store-publish-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          {destination === null ? (
            <>
              <p className="share-destination-lede">
                {t("features.store.shareDialog.destinationLede")}
              </p>
              <div className="share-destination-options">
                <button
                  type="button"
                  className="share-destination-option"
                  onClick={() => selectDestination("circle")}
                >
                  <span className="share-destination-option-icon">
                    <Users size={20} />
                  </span>
                  <span className="share-destination-option-body">
                    <span className="share-destination-option-name">
                      {t("features.store.shareDialog.circleOptionName")}
                    </span>
                    <span className="share-destination-option-desc">
                      {t("features.store.shareDialog.circleOptionDesc")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="share-destination-option"
                  onClick={() => selectDestination("store")}
                >
                  <span className="share-destination-option-icon">
                    <Store size={20} />
                  </span>
                  <span className="share-destination-option-body">
                    <span className="share-destination-option-name">
                      {t("features.store.shareDialog.storeOptionName")}
                    </span>
                    <span className="share-destination-option-desc">
                      {t("features.store.shareDialog.storeOptionDesc")}
                    </span>
                  </span>
                </button>
              </div>
            </>
          ) : (
            <>
              {updatablePackages.length > 0 ? (
                <label className="store-publish-dialog-row">
                  <input
                    type="checkbox"
                    checked={asUpdate}
                    onChange={(event) => setAsUpdate(event.target.checked)}
                  />
                  <span>{t("features.store.shareDialog.updateExisting")}</span>
                </label>
              ) : null}

              {asUpdate ? (
                <div className="store-publish-dialog-field">
                  <span className="store-publish-dialog-field-label">
                    {t("features.store.shareDialog.existingAddon")}
                  </span>
                  <Select
                    value={updatePackageId}
                    onValueChange={(value) => setUpdatePackageId(value)}
                    aria-label={t("features.store.shareDialog.existingAddon")}
                    placeholder={t(
                      "features.store.shareDialog.selectPlaceholder",
                    )}
                    options={[
                      {
                        value: "",
                        label: t(
                          "features.store.shareDialog.selectPlaceholder",
                        ),
                      },
                      ...updatablePackages.map((pkg) => ({
                        value: pkg.packageId,
                        label: pkg.displayName,
                      })),
                    ]}
                  />
                </div>
              ) : (
                <>
                  <label className="store-publish-dialog-field">
                    <span className="store-publish-dialog-field-label">
                      {t("features.store.shareDialog.nameLabel")}
                    </span>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder={t(
                        "features.store.shareDialog.namePlaceholder",
                      )}
                      maxLength={120}
                    />
                  </label>
                  <label className="store-publish-dialog-field">
                    <span className="store-publish-dialog-field-label">
                      {t("features.store.shareDialog.descriptionLabel")}{" "}
                      <span className="store-publish-dialog-field-hint">
                        {t("features.store.shareDialog.optionalHint")}
                      </span>
                    </span>
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={
                        destination === "circle"
                          ? t(
                              "features.store.shareDialog.descriptionPlaceholderCircle",
                            )
                          : t(
                              "features.store.shareDialog.descriptionPlaceholderStore",
                            )
                      }
                      rows={3}
                      maxLength={4_000}
                    />
                  </label>
                  {destination === "store" ? (
                    <div className="store-publish-dialog-field">
                      <span className="store-publish-dialog-field-label">
                        {t("features.store.shareDialog.categoryLabel")}
                      </span>
                      <Select
                        value={category}
                        onValueChange={(value) =>
                          setCategory(value as typeof category)
                        }
                        aria-label={t(
                          "features.store.shareDialog.categoryLabel",
                        )}
                        placeholder={t(
                          "features.store.shareDialog.categoryPlaceholder",
                        )}
                        options={[
                          {
                            value: "",
                            label: t(
                              "features.store.shareDialog.categoryPlaceholder",
                            ),
                          },
                          {
                            value: "apps-games",
                            label: t("features.store.categories.appsGames"),
                          },
                          {
                            value: "productivity",
                            label: t("features.store.categories.productivity"),
                          },
                          {
                            value: "customization",
                            label: t("features.store.categories.customization"),
                          },
                          {
                            value: "skills-agents",
                            label: t("features.store.categories.skillsAgents"),
                          },
                          {
                            value: "integrations",
                            label: t("features.store.categories.integrations"),
                          },
                          {
                            value: "other",
                            label: t("features.store.categories.other"),
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                </>
              )}

              {destination === "circle" ? (
                <div className="store-publish-dialog-field">
                  <span className="store-publish-dialog-field-label">
                    {t("features.store.shareDialog.sendTo")}
                  </span>
                  {communities.length === 0 && friends.length === 0 ? (
                    <p className="share-recipient-empty">
                      {t("features.store.shareDialog.noRecipients")}
                    </p>
                  ) : (
                    <div className="share-recipient-list">
                      {communities.map((community) => {
                        const key: RecipientKey = `room:${community.room._id}`;
                        const selected = recipients.has(key);
                        const name =
                          community.room.title ??
                          t("features.store.shareDialog.communityFallbackName");
                        return (
                          <button
                            key={key}
                            type="button"
                            className="share-recipient-item"
                            data-selected={selected || undefined}
                            onClick={() => toggleRecipient(key)}
                          >
                            <Avatar fallback={name} size="small" />
                            <span className="share-recipient-name">{name}</span>
                            <span className="share-recipient-tag">
                              {t("features.store.shareDialog.communityTag")}
                            </span>
                            {selected ? (
                              <Check
                                size={15}
                                className="share-recipient-check"
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        );
                      })}
                      {friends.map((friend) => {
                        const key: RecipientKey = `friend:${friend.profile.ownerId}`;
                        const selected = recipients.has(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            className="share-recipient-item"
                            data-selected={selected || undefined}
                            onClick={() => toggleRecipient(key)}
                          >
                            <Avatar
                              fallback={friend.profile.username}
                              src={friend.profile.avatarUrl}
                              size="small"
                            />
                            <span className="share-recipient-name">
                              @{friend.profile.username}
                            </span>
                            {selected ? (
                              <Check
                                size={15}
                                className="share-recipient-check"
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              <p className="share-destination-note">
                {destination === "circle"
                  ? t("features.store.shareDialog.circleNote")
                  : t("features.store.shareDialog.storeNote")}
              </p>
            </>
          )}

          <div className="store-publish-dialog-actions">
            {destination !== null ? (
              <button
                type="button"
                className="pill-btn"
                onClick={() => selectDestination(null)}
                disabled={submitting}
              >
                {t("common.back")}
              </button>
            ) : null}
            <button type="button" className="pill-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            {destination !== null ? (
              <button
                type="button"
                className="pill-btn pill-btn--primary"
                onClick={() => void handleSubmit()}
                disabled={
                  submitting ||
                  (destination === "circle" && recipients.size === 0)
                }
              >
                {submitting
                  ? t("features.store.shareDialog.submitPending")
                  : destination === "circle"
                    ? t("features.store.shareDialog.submitCircle")
                    : t("features.store.shareDialog.submitStore")}
              </button>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
