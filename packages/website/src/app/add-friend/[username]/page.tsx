import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InviteForwardView } from "@/components/invite/invite-forward-view";

export const metadata: Metadata = {
  title: "Friend invite",
  description: "Connect with a friend on Stella.",
  robots: {
    index: false,
    follow: false,
  },
};

// Matches the app's social username shape (see backend USERNAME_REGEX);
// lenient on case — the app lowercases before sending the request.
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export default async function AddFriendInvitePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const normalized = decodeURIComponent(username ?? "").trim();
  if (!USERNAME_PATTERN.test(normalized)) {
    notFound();
  }
  return (
    <div className="stella-page">
      <InviteForwardView
        kind="add-friend"
        value={normalized.toLowerCase()}
      />
    </div>
  );
}
