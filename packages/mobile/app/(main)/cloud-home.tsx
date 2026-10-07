import { useRouter } from "expo-router";
import { CloudHomeSettings } from "../../src/components/CloudHomeSettings";
import { MainDetailSurface } from "../../src/components/MainScreenSurface";
import { useAccountSession } from "../../src/lib/auth-client";
import { observeCloudConversationIdentity } from "../../src/lib/cloud-conversation-auth";

export default function CloudHomeScreen() {
  const router = useRouter();
  const session = useAccountSession();
  const identity = observeCloudConversationIdentity(session.data ?? null);

  return (
    <MainDetailSurface>
      <CloudHomeSettings
        key={identity?.identityKey ?? "signed-out"}
        identity={identity}
        onBack={() => router.back()}
        onSignIn={() => router.replace("/login")}
      />
    </MainDetailSurface>
  );
}
