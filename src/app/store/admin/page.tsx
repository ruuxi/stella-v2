import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { StoreAdminClient } from "./admin-client";
import "../store.css";

export const metadata: Metadata = {
  title: "Store review queue",
  description: "Manual approval queue for Stella Store submissions.",
  robots: { index: false, follow: false },
};

export default function StoreAdminPage() {
  return (
    <div className="stella-page">
      <SiteHeader />
      <StoreAdminClient />
    </div>
  );
}
