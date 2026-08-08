import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { loadLastMainTabHref } from "../../src/lib/last-main-tab";

export default function MainIndex() {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    void loadLastMainTabHref().then(setHref);
  }, []);

  if (!href) return null;

  return <Redirect href={href} />;
}
