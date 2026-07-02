"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Hourglass, Package, Smile, Sparkles } from "lucide-react";
import {
  getPublicPackage,
  listMyEmojiPacks,
  listMyStoreSubmissions,
  listMyUserPets,
} from "../lib/convex";
import { userPetToPublicPet } from "../lib/pet-media";
import type {
  MyStoreSubmission,
  PublicPet,
  StoreInstall,
  StorePackage,
} from "../lib/types";
import { EmptyState, StoreLoadingSpinner } from "../components/shared";
import { isStoreUpdateAvailable } from "../lib/format";
import { useEmojiBridge, usePetBridge } from "../lib/use-store-bridge";
import { PetCard, PetDetailsDialog } from "../pets/pets-tab";
import { EmojiPackCard } from "../emojis/emojis-tab";
import { PackageCard } from "../discover/discover-ui";

type LibraryTabProps = {
  installedMods: StoreInstall[];
  installingId: string | null;
  onSelectPackage: (packageId: string) => void;
  onInstallPackage: (pkg: StorePackage) => void;
};

/**
 * Renders one installed mod by fetching its package record directly. The
 * Library used to read these out of the Discover browse list, but that grid
 * is now paginated, so a mod whose package isn't in the first page would have
 * silently dropped out. Each card owning its own (cached, deduped) query
 * keeps the section complete regardless of how far Discover has scrolled.
 */
function InstalledModCard({
  installedMod,
  installingId,
  onSelectPackage,
  onInstallPackage,
}: {
  installedMod: StoreInstall;
  installingId: string | null;
  onSelectPackage: (packageId: string) => void;
  onInstallPackage: (pkg: StorePackage) => void;
}) {
  const pkg = useQuery(getPublicPackage, {
    packageId: installedMod.packageId,
  });
  if (!pkg) return null;
  return (
    <PackageCard
      pkg={pkg}
      installed
      updateAvailable={isStoreUpdateAvailable(pkg, installedMod)}
      installing={installingId === pkg.packageId}
      onOpen={() => onSelectPackage(pkg.packageId)}
      onInstall={() => onInstallPackage(pkg)}
    />
  );
}

/**
 * One-stop "Library" surface: everything the user has on this account
 * — installed mods, pets they own or created, and emoji packs they
 * own. Replaces the per-tab "My pets" / "My emojis" toggles so there's
 * one place normal users expect to find what's theirs.
 */
export function LibraryTab({
  installedMods,
  installingId,
  onSelectPackage,
  onInstallPackage,
}: LibraryTabProps) {
  const myUserPets = useQuery(listMyUserPets, {});
  const myPacks = useQuery(listMyEmojiPacks, {});
  const mySubmissions = useQuery(listMyStoreSubmissions, {});

  const userPetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pet of myUserPets ?? []) ids.add(pet.petId);
    return ids;
  }, [myUserPets]);

  const pets = usePetBridge(userPetIds);
  const emojis = useEmojiBridge();

  const myPetCards = useMemo<PublicPet[]>(
    () => (myUserPets ?? []).map(userPetToPublicPet),
    [myUserPets],
  );

  const [detailsPet, setDetailsPet] = useState<PublicPet | null>(null);

  const myEmojiPacks = myPacks ?? [];

  const loadingPets = myUserPets === undefined;
  const loadingPacks = myPacks === undefined;

  const submissions = mySubmissions ?? [];

  const totalCount =
    installedMods.length +
    myPetCards.length +
    myEmojiPacks.length +
    submissions.length;

  if (!loadingPets && !loadingPacks && totalCount === 0) {
    return (
      <main className="library-page">
        <header className="library-page-header">
          <h1 className="library-page-title">Library</h1>
          <p className="library-page-subtitle">
            Everything you&apos;ve added or created lives here — mods, pets,
            and emoji packs.
          </p>
        </header>
        <EmptyState
          icon={<Package size={32} />}
          title="Your library is empty"
          description="Get a mod, create a pet, or generate an emoji pack to see it here."
        />
      </main>
    );
  }

  return (
    <main className="library-page">
      <header className="library-page-header">
        <div className="library-page-heading">
          <h1 className="library-page-title">Library</h1>
          <span className="library-page-count">{totalCount} items</span>
        </div>
        <p className="library-page-subtitle">
          Everything you&apos;ve added or created. Mods you&apos;ve installed,
          pets you own, and emoji packs you&apos;ve made.
        </p>
      </header>

      {pets.actionError ? (
        <div className="store-status" data-variant="error">
          {pets.actionError}
        </div>
      ) : null}
      {emojis.actionError ? (
        <div className="store-status" data-variant="error">
          {emojis.actionError}
        </div>
      ) : null}

      <LibrarySection
        icon={<Package size={16} aria-hidden />}
        title="Mods"
        count={installedMods.length}
        empty="No mods installed yet."
      >
        {installedMods.length > 0 ? (
          <div className="store-grid">
            {installedMods.map((mod) => (
              <InstalledModCard
                key={mod.packageId}
                installedMod={mod}
                installingId={installingId}
                onSelectPackage={onSelectPackage}
                onInstallPackage={onInstallPackage}
              />
            ))}
          </div>
        ) : null}
      </LibrarySection>

      {submissions.length > 0 ? (
        <LibrarySection
          icon={<Hourglass size={16} aria-hidden />}
          title="Store submissions"
          count={submissions.length}
          empty="No store submissions."
        >
          <div className="library-submission-list">
            {submissions.map((submission) => (
              <SubmissionRow
                key={submission.releaseId}
                submission={submission}
              />
            ))}
          </div>
        </LibrarySection>
      ) : null}

      <LibrarySection
        icon={<Sparkles size={16} aria-hidden />}
        title="Pets"
        count={myPetCards.length}
        loading={loadingPets}
        empty="No pets yet — open the Pets tab to create one."
      >
        {myPetCards.length > 0 ? (
          <div className="pets-grid">
            {myPetCards.map((pet) => {
              const selected = pets.petState.selectedPetId === pet.id;
              const working = pets.workingPetId === pet.id;
              return (
                <PetCard
                  key={pet.id}
                  pet={pet}
                  installed
                  selected={selected}
                  working={working}
                  onOpen={() => setDetailsPet(pet)}
                  onGet={() => void pets.installPet(pet)}
                  onSelect={() => pets.selectPet(pet.id)}
                  onRemove={() => pets.removePet(pet.id)}
                />
              );
            })}
          </div>
        ) : null}
      </LibrarySection>

      <LibrarySection
        icon={<Smile size={16} aria-hidden />}
        title="Emoji packs"
        count={myEmojiPacks.length}
        loading={loadingPacks}
        empty="No emoji packs yet — open the Emojis tab to create one."
      >
        {myEmojiPacks.length > 0 ? (
          <div className="emoji-pack-grid">
            {myEmojiPacks.map((pack) => {
              const active = emojis.activePackId === pack.packId;
              return (
                <EmojiPackCard
                  key={pack._id ?? pack.packId}
                  pack={pack}
                  active={active}
                  onOpen={() => {
                    if (active) {
                      void emojis.clearEmojiPack(pack.packId);
                    } else {
                      void emojis.installEmojiPack(pack);
                    }
                  }}
                />
              );
            })}
          </div>
        ) : null}
      </LibrarySection>

      {detailsPet ? (
        <PetDetailsDialog
          key={detailsPet.id}
          pet={detailsPet}
          installed={pets.installedPetIds.has(detailsPet.id)}
          selected={pets.petState.selectedPetId === detailsPet.id}
          working={pets.workingPetId === detailsPet.id}
          onGet={() => pets.installPet(detailsPet)}
          onSelect={() => pets.selectPet(detailsPet.id)}
          onRemove={() => pets.removePet(detailsPet.id)}
          onClose={() => setDetailsPet(null)}
        />
      ) : null}
    </main>
  );
}

const SUBMISSION_STATUS_LABEL: Record<MyStoreSubmission["status"], string> = {
  pending: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * One store submission awaiting (or past) manual review by the Stella
 * team. Submissions are per-release: a first release publishes the
 * package on approval; an update goes live for installers on approval.
 */
function SubmissionRow({ submission }: { submission: MyStoreSubmission }) {
  return (
    <div className="library-submission-row" data-status={submission.status}>
      <div className="library-submission-main">
        <span className="library-submission-name">
          {submission.displayName}
        </span>
        <span className="library-submission-meta">
          {submission.isFirstRelease
            ? "New add-on"
            : `Update — release ${submission.releaseNumber}`}
          {" · "}
          {new Date(submission.submittedAt).toLocaleDateString()}
        </span>
        {submission.status === "rejected" && submission.rejectionReason ? (
          <span className="library-submission-reason">
            {submission.rejectionReason}
          </span>
        ) : null}
      </div>
      <span
        className="library-submission-status"
        data-status={submission.status}
      >
        {SUBMISSION_STATUS_LABEL[submission.status]}
      </span>
    </div>
  );
}

function LibrarySection({
  icon,
  title,
  count,
  loading = false,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  loading?: boolean;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="library-section">
      <div className="library-section-header">
        <span className="library-section-icon">{icon}</span>
        <span className="library-section-title">{title}</span>
        <span className="library-section-count">{count}</span>
      </div>
      {loading ? (
        <StoreLoadingSpinner compact />
      ) : count === 0 ? (
        <div className="library-section-empty">{empty}</div>
      ) : (
        children
      )}
    </section>
  );
}
