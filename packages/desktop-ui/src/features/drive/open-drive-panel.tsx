import { displayTabs } from "@/features/workspace-display/tab-store";
import { CloudBoundary } from "@/features/cloud/CloudBoundary";
import { DrivePanel } from "./DrivePanel";
import "./drive-panel.css";

const DRIVE_TAB_ID = "cloud-drive";

const DriveUnavailable = () => (
  <main className="drive-panel">
    <p className="drive-panel__state">
      The drive isn’t available on this deployment yet.
    </p>
  </main>
);

export const openDrivePanel = (): void => {
  displayTabs.openTab({
    id: DRIVE_TAB_ID,
    kind: "canvas",
    title: "Drive",
    tooltip: "Your cloud drive",
    metadata: { displayType: "cloud-drive" },
    render: () => (
      <CloudBoundary fallback={<DriveUnavailable />}>
        <DrivePanel />
      </CloudBoundary>
    ),
  });
};
