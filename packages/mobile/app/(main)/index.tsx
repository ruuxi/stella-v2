import { useRouter } from "expo-router";
import { useEffect } from "react";
import {
  enterMainShell,
  loadLastMainTabHref,
} from "../../src/lib/last-main-tab";

export default function MainIndex() {
  const router = useRouter();

  useEffect(() => {
    void loadLastMainTabHref().then((href) => enterMainShell(router, href));
  }, [router]);

  return null;
}
