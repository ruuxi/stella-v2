"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { CheckCircle2, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { isConvexConfigured } from "@/lib/convex-urls";
import {
  approveStoreSubmission,
  isStoreAdmin,
  listPendingStoreSubmissions,
  rejectStoreSubmission,
} from "../lib/convex";
import type { PendingStoreSubmission } from "../lib/types";
import {
  EmptyState,
  PackageArtwork,
  StoreLoadingSpinner,
} from "../components/shared";
import { StoreMarkdown } from "../components/store-markdown";

/**
 * Stella-team-only approval queue for Store submissions. Every publish
 * from the desktop app lands here as a pending release; nothing goes
 * live until it is approved on this page. Access is gated server-side
 * (`data/store_admin`) by the caller's account email.
 */
export function StoreAdminClient() {
  const auth = useConvexAuth();
  const isAdmin = useQuery(isStoreAdmin, isConvexConfigured() ? {} : "skip");

  if (!isConvexConfigured()) {
    return (
      <AdminShell>
        <EmptyState
          icon={<ShieldAlert size={32} />}
          title="Store unavailable"
          description="Convex is not configured for this website build."
        />
      </AdminShell>
    );
  }

  if (auth.isLoading || isAdmin === undefined) {
    return (
      <AdminShell>
        <StoreLoadingSpinner />
      </AdminShell>
    );
  }

  if (!isAdmin) {
    return (
      <AdminShell>
        <EmptyState
          icon={<ShieldAlert size={32} />}
          title="Not authorized"
          description="This page is restricted to the Stella team. Sign in with a team account to review submissions."
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <PendingQueue />
    </AdminShell>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="store-root" data-tab="admin">
      <div className="store-scroll">
        <div className="store-admin-page">
          <header className="library-page-header">
            <div className="library-page-heading">
              <h1 className="library-page-title">Store review queue</h1>
            </div>
            <p className="library-page-subtitle">
              Submissions wait here until a Stella team member approves them.
              Approving publishes the release; rejecting returns it to the
              submitter with an optional reason.
            </p>
          </header>
          {children}
        </div>
      </div>
    </main>
  );
}

function PendingQueue() {
  const pending = useQuery(listPendingStoreSubmissions, {});

  if (pending === undefined) {
    return <StoreLoadingSpinner />;
  }
  if (pending.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 size={32} />}
        title="Queue is clear"
        description="No submissions are waiting for review."
      />
    );
  }
  return (
    <div className="store-admin-queue">
      {pending.map((submission) => (
        <SubmissionCard key={submission.releaseId} submission={submission} />
      ))}
    </div>
  );
}

const ADVISORY_LABEL: Record<
  NonNullable<PendingStoreSubmission["advisoryReview"]>["outcome"],
  { label: string; icon: React.ReactNode }
> = {
  passed: {
    label: "Automated pre-review passed",
    icon: <ShieldCheck size={14} aria-hidden />,
  },
  flagged: {
    label: "Automated pre-review flagged issues",
    icon: <ShieldX size={14} aria-hidden />,
  },
  failed: {
    label: "Automated pre-review did not complete",
    icon: <ShieldAlert size={14} aria-hidden />,
  },
};

function SubmissionCard({
  submission,
}: {
  submission: PendingStoreSubmission;
}) {
  const approve = useMutation(approveStoreSubmission);
  const reject = useMutation(rejectStoreSubmission);
  const [working, setWorking] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (action: "approve" | "reject") => {
    setWorking(action);
    setError(null);
    try {
      if (action === "approve") {
        await approve({ releaseId: submission.releaseId });
      } else {
        const trimmed = reason.trim();
        await reject({
          releaseId: submission.releaseId,
          ...(trimmed ? { reason: trimmed } : {}),
        });
      }
      // The pending list is a live subscription; the card drops out on
      // success, so no local "done" state is needed.
    } catch (caught) {
      setError(
        (caught as { data?: { message?: string } })?.data?.message ??
          (caught as Error)?.message ??
          "Action failed.",
      );
    } finally {
      setWorking(null);
    }
  };

  const advisory = submission.advisoryReview;

  return (
    <section className="store-admin-card">
      <header className="store-admin-card-header">
        <PackageArtwork
          iconUrl={submission.iconUrl}
          name={submission.displayName}
          className="store-admin-card-artwork"
          letterClassName="store-admin-card-artwork-letter"
        />
        <div className="store-admin-card-heading">
          <span className="store-admin-card-title">
            {submission.displayName}
          </span>
          <span className="store-admin-card-meta">
            {submission.packageId}
            {" · "}
            {submission.isFirstRelease
              ? "new add-on"
              : `update, release ${submission.releaseNumber}`}
            {submission.category ? ` · ${submission.category}` : ""}
            {submission.authorUsername ? ` · @${submission.authorUsername}` : ""}
            {" · "}
            {new Date(submission.submittedAt).toLocaleString()}
          </span>
        </div>
      </header>

      {submission.description ? (
        <p className="store-admin-card-description">
          {submission.description}
        </p>
      ) : null}
      {submission.releaseNotes ? (
        <p className="store-admin-card-description">
          <strong>Release notes:</strong> {submission.releaseNotes}
        </p>
      ) : null}

      {advisory ? (
        <div
          className="store-admin-advisory"
          data-outcome={advisory.outcome}
        >
          <span className="store-admin-advisory-header">
            {ADVISORY_LABEL[advisory.outcome].icon}
            {ADVISORY_LABEL[advisory.outcome].label}
          </span>
          <span className="store-admin-advisory-summary">
            {advisory.summary}
          </span>
          {advisory.findings.length > 0 ? (
            <ul className="store-admin-advisory-findings">
              {advisory.findings.map((finding, index) => (
                <li key={index}>
                  <code>{finding.path}</code> — {finding.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="store-admin-advisory" data-outcome="failed">
          <span className="store-admin-advisory-header">
            <ShieldAlert size={14} aria-hidden />
            No automated pre-review attached
          </span>
        </div>
      )}

      {submission.commits && submission.commits.length > 0 ? (
        <details className="store-admin-details">
          <summary>Reference commits ({submission.commits.length})</summary>
          <ul className="store-admin-commit-list">
            {submission.commits.map((commit) => (
              <li key={commit.hash}>
                <code>{commit.hash.slice(0, 10)}</code> {commit.subject}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <details className="store-admin-details">
        <summary>
          Blueprint ({submission.blueprintMarkdown.length.toLocaleString()}{" "}
          chars) — the behaviour spec installers&apos; agents implement
        </summary>
        <div className="store-admin-blueprint">
          <StoreMarkdown text={submission.blueprintMarkdown} />
        </div>
      </details>

      {error ? (
        <div className="store-status" data-variant="error">
          {error}
        </div>
      ) : null}

      <div className="store-admin-card-actions">
        {rejecting ? (
          <>
            <textarea
              className="store-admin-reason"
              placeholder="Reason shown to the submitter (optional)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={2000}
            />
            <div className="store-admin-card-buttons">
              <button
                type="button"
                className="store-admin-button"
                onClick={() => setRejecting(false)}
                disabled={working !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="store-admin-button"
                data-variant="danger"
                onClick={() => void run("reject")}
                disabled={working !== null}
              >
                {working === "reject" ? "Rejecting…" : "Confirm reject"}
              </button>
            </div>
          </>
        ) : (
          <div className="store-admin-card-buttons">
            <button
              type="button"
              className="store-admin-button"
              data-variant="danger"
              onClick={() => setRejecting(true)}
              disabled={working !== null}
            >
              Reject…
            </button>
            <button
              type="button"
              className="store-admin-button"
              data-variant="primary"
              onClick={() => void run("approve")}
              disabled={working !== null}
            >
              {working === "approve" ? "Approving…" : "Approve & publish"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
