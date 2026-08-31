import type { ReactNode } from "react";
import { ConvexAuthProvider } from "@/components/auth/convex-auth-provider";

export default function BillingLayout({ children }: { children: ReactNode }) {
  return <ConvexAuthProvider>{children}</ConvexAuthProvider>;
}
