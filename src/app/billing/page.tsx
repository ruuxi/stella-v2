import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { BillingClient } from "./billing-client";
import "./billing.css";

export const metadata: Metadata = {
  title: "Billing",
  description:
    "Choose a Stella plan. Go raises your usage limits; Pro adds image, video, 3D and voice generation plus orchestrator mode.",
  // In-app account page (also embedded in the desktop app). The public,
  // crawlable equivalent is /pricing, so keep this out of the index to avoid
  // thin/duplicate content while still allowing links to be followed.
  robots: { index: false, follow: true },
};

export default function BillingPage() {
  return (
    <div className="stella-page">
      <SiteHeader />
      <BillingClient />
    </div>
  );
}
