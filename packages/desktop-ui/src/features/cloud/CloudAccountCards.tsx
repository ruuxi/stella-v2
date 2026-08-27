import { CloudEnginesCard } from "./CloudEnginesCard";
import { CloudProjectsCard } from "./CloudProjectsCard";
import { StellaInteriorCard } from "./StellaInteriorCard";
import { CloudBoundary } from "./CloudBoundary";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";

const unavailable = (label: string) => (
  <div className="settings-card" role="alert">
    <h3 className="settings-card-title">{label}</h3>
    <div className="settings-row">
      <div className="settings-row-sublabel">
        This cloud control is unavailable right now.
      </div>
    </div>
  </div>
);

function AccountScopedCloudCards() {
  return (
    <>
      <CloudBoundary fallback={unavailable("Cloud engines")}>
        <CloudEnginesCard />
      </CloudBoundary>
      <CloudBoundary fallback={unavailable("Cloud projects")}>
        <CloudProjectsCard />
      </CloudBoundary>
      <CloudBoundary fallback={unavailable("Stella interior")}>
        <StellaInteriorCard />
      </CloudBoundary>
    </>
  );
}

/** Account-settings cloud surfaces kept behind one import for the host tab. */
export function CloudAccountCards() {
  const { cloudMode, accountScope } = useCloudMode();
  if (!cloudMode) return null;
  return (
    <AccountScopedCloudCards key={accountScope} />
  );
}
