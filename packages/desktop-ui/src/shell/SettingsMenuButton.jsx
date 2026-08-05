import { displaySearchStore } from "@/features/workspace-display/display-search-store";
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarSections,
} from "@/features/workspace-display/sidebar-sections";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import {
  getVisibleSettingsDestinations,
  isSettingsLocation,
} from "@/shell/sidebar-sections/settings-navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Settings } from "@/ui/icons";

export function openSettingsMenuLocation(location, connectHint) {
  displaySearchStore.close();
  if (location === "connect" && connectHint.active) {
    connectHint.dismiss();
  }
  sidebarSections.openLocation("settings", location);
}

export function SettingsMenuButton({ className, showActiveState = false }) {
  const activeSection = useActiveSidebarSection();
  const location = useSidebarSections().locations.settings;
  const { hasConnectedAccount } = useAuthSessionState();
  const connectHint = usePostOnboardingHint("connect");
  const selectedLocation =
    activeSection === "settings" && isSettingsLocation(location)
      ? location
      : undefined;
  const destinations = getVisibleSettingsDestinations(hasConnectedAccount);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={className}
          data-active={
            showActiveState && activeSection === "settings" ? "true" : undefined
          }
          aria-pressed={
            showActiveState ? activeSection === "settings" : undefined
          }
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={14} strokeWidth={1.75} />
          {connectHint.active ? (
            <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="shell-settings-menu"
        side="bottom"
        align="end"
        sideOffset={8}
        aria-label="Settings destinations"
      >
        <DropdownMenuRadioGroup value={selectedLocation}>
          {destinations.map(({ id, label, Icon }) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              onSelect={() => openSettingsMenuLocation(id, connectHint)}
            >
              <span data-slot="dropdown-menu-item-icon">
                <Icon size={15} strokeWidth={1.75} />
              </span>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
