import { useRouter } from "expo-router";
import { EngineAccountsSettings } from "../../src/components/EngineAccountsSettings";
import { MainDetailSurface } from "../../src/components/MainScreenSurface";

export default function EngineAccountsScreen() {
  const router = useRouter();
  return (
    <MainDetailSurface>
      <EngineAccountsSettings onBack={() => router.back()} />
    </MainDetailSurface>
  );
}
