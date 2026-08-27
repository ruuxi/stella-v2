import { useRouter } from "expo-router";
import { CloudHomeSettings } from "../../src/components/CloudHomeSettings";
import { authClient } from "../../src/lib/auth-client";
import { observeCloudConversationIdentity } from "../../src/lib/cloud-conversation-auth";
import { isGuest } from "../../src/lib/guest-mode";

export default function CloudHomeScreen() {
  const router = useRouter();
  const session = authClient.useSession();
  const identity = !isGuest()
    ? observeCloudConversationIdentity(session.data ?? null)
    : null;

  return (
    <CloudHomeSettings
      key={identity?.identityKey ?? "signed-out"}
      identity={identity}
      onBack={() => router.replace("/account")}
      onSignIn={() => router.replace("/login")}
    />
  );
}
