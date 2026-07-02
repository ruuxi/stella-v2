import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InviteForwardView } from "@/components/invite/invite-forward-view";

export const metadata: Metadata = {
  title: "Community invite",
  description: "Join a community on Stella.",
  robots: {
    index: false,
    follow: false,
  },
};

// Codes are 8 chars, optionally displayed as ABCD-EFGH; be lenient about
// case/hyphen here — the app normalizes before joining.
const CODE_PATTERN = /^[A-Za-z0-9-]{8,9}$/;

export default async function JoinInvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const normalized = decodeURIComponent(code ?? "").trim();
  if (!CODE_PATTERN.test(normalized)) {
    notFound();
  }
  return (
    <div className="stella-page">
      <InviteForwardView
        kind="join-community"
        value={normalized.replace(/-/g, "").toUpperCase()}
      />
    </div>
  );
}
