import type { CloudBrowserInteractionSummary } from "@stella/contracts/cloud-browser";
import { Lock } from "@/ui/icons";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { useT } from "@/shared/i18n";
import "./cloud-browser-needs-you.css";

export function CloudBrowserNeedsYouList({
  interactions,
  onNavigate,
}: {
  interactions: readonly CloudBrowserInteractionSummary[];
  onNavigate?: () => void;
}) {
  const t = useT();
  return (
    <ul
      className="cloud-browser-needs-you"
      aria-label={t("cloudBrowser.needsYou.title")}
    >
      {interactions.map((interaction) => {
        const origin = interaction.displayOrigin;
        return (
          <li key={interaction.interactionId}>
            <button
              type="button"
              onClick={() => {
                sidebarSections.openLocation(
                  "takeover",
                  interaction.interactionId,
                );
                onNavigate?.();
              }}
            >
              <span
                className="cloud-browser-needs-you__icon"
                aria-hidden="true"
              >
                <Lock size={14} />
              </span>
              <span className="cloud-browser-needs-you__copy">
                <strong>{origin}</strong>
                <span>
                  {interaction.kind === "device_code"
                    ? t("cloudBrowser.needsYou.deviceCode", { origin })
                    : t("cloudBrowser.needsYou.signIn", { origin })}
                </span>
              </span>
              <span className="cloud-browser-needs-you__action">
                {t("cloudBrowser.needsYou.open")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
