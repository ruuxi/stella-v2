import { useRouter } from "expo-router";
import { SettingsContent } from "../../src/components/SettingsContent";

export default function SettingsScreen() {
  const router = useRouter();
  return <SettingsContent onClose={() => router.dismissTo("/chat")} />;
}
