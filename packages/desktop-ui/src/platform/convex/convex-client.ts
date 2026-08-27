import { ConvexReactClient } from "convex/react";
import { readConfiguredConvexUrl } from "@/shared/lib/convex-urls";

const configuredConvexUrl = readConfiguredConvexUrl(
  import.meta.env.VITE_CONVEX_URL as string | undefined,
);

if (!configuredConvexUrl) {
  console.warn(
    "VITE_CONVEX_URL is not set; cloud-backed features remain unavailable until this build is configured.",
  );
}

export const convexClient = new ConvexReactClient(
  configuredConvexUrl ?? "http://127.0.0.1:3210",
);
