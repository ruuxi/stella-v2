import {
  useState,
  useMemo,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { isHiddenOverlay } from "@/shared/theme/themes";
import { Popover, PopoverContent, PopoverTrigger, PopoverBody } from "@/ui/popover";
import { Button } from "@/ui/button";
import { ThemeOrb } from "@/ui/theme-orb";
import "./ThemePicker.css";

type ColorScheme = "light" | "dark" | "system";

type ThemePickerTriggerProps = {
  style?: CSSProperties;
  tabIndex?: number;
  "aria-hidden"?: boolean;
  "data-slot"?: string;
};

const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

interface ThemePickerProps {

  inline?: boolean;
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;

  trigger?: ReactElement;

  triggerLabel?: string;

  side?: "top" | "bottom";

  align?: "start" | "center" | "end";
}

export function ThemePicker({
  inline = false,
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onThemeSelect,
  trigger,
  triggerLabel = "Theme",
  side = "top",
  align = "end",
}: ThemePickerProps) {
  const {
    selectedThemeId,
    themes,
    colorMode,
    gradientMode,
    gradientColor,
    flat,
    resolvedColorMode,
  } = useTheme();
  const {
    setTheme,
    setColorMode,
    setGradientMode,
    setGradientColor,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
  } = useThemeControl();

  const [internalOpen, setInternalOpen] = useState(false);
  const [hoveredThemeId, setHoveredThemeId] = useState<string | null>(null);

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;

  const sortedThemes = useMemo(
    () =>
      [...themes]
        .filter((t) => !isHiddenOverlay(t))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [themes]
  );

  const selectedTheme = useMemo(
    () => sortedThemes.find((t) => t.id === selectedThemeId),
    [sortedThemes, selectedThemeId]
  );
  const hoveredTheme = useMemo(
    () => sortedThemes.find((t) => t.id === hoveredThemeId),
    [sortedThemes, hoveredThemeId]
  );

  const triggerElement =
    trigger && isValidElement<ThemePickerTriggerProps>(trigger) ? trigger : null;

  const popoverTrigger =
    triggerElement
      ? cloneElement(triggerElement, {
          "data-slot": "theme-picker-trigger",
          ...(hideTrigger
            ? {
                style: {
                  ...(typeof triggerElement.props.style === "object" &&
                  triggerElement.props.style !== null &&
                  !Array.isArray(triggerElement.props.style)
                    ? triggerElement.props.style
                    : {}),
                  opacity: 0,
                  pointerEvents: "none",
                  position: "absolute",
                },
                tabIndex: -1,
                "aria-hidden": true,
              }
            : {}),
        })
      : null;

  const themeContent = (
    <div
      data-slot="theme-picker-sections"
      onMouseLeave={() => {
        setHoveredThemeId(null);
        cancelPreview();
      }}
    >
      <div data-slot="theme-picker-section" data-bordered>
        <div data-slot="theme-picker-label">Appearance</div>
        <div data-slot="theme-picker-button-row">
          {COLOR_SCHEMES.map((scheme) => (
            <Button
              key={scheme.id}
              size="small"
              variant={colorMode === scheme.id ? "secondary" : "ghost"}
              data-slot="theme-picker-option-button"
              onClick={() => setColorMode(scheme.id)}
            >
              {scheme.label}
            </Button>
          ))}
        </div>
      </div>

      {

}
      <div
        data-slot="theme-picker-section"
        data-bordered
        data-disabled={flat || undefined}
        role="group"
        aria-label="Gradient controls"
        aria-disabled={flat || undefined}
      >
        <div data-slot="theme-picker-label">Gradient Style</div>
        <div data-slot="theme-picker-button-row">
          {(["soft", "flat"] as const).map((value) => (
            <Button
              key={value}
              size="small"
              variant={gradientMode === value ? "secondary" : "ghost"}
              data-slot="theme-picker-option-button"
              onClick={() => setGradientMode(value)}
              disabled={flat}
              aria-disabled={flat || undefined}
            >
              {value === "soft" ? "Soft" : "Flat"}
            </Button>
          ))}
        </div>

        <div data-slot="theme-picker-label">Gradient Color</div>
        <div data-slot="theme-picker-button-row">
          {(["relative", "strong"] as const).map((value) => (
            <Button
              key={value}
              size="small"
              variant={gradientColor === value ? "secondary" : "ghost"}
              data-slot="theme-picker-option-button"
              onClick={() => setGradientColor(value)}
              disabled={flat}
              aria-disabled={flat || undefined}
            >
              {value === "relative" ? "Relative" : "Strong"}
            </Button>
          ))}
        </div>
      </div>

      <div data-slot="theme-picker-section">
        {

}
        <div data-slot="theme-picker-label" data-row>
          <span>Theme</span>
          <span data-slot="theme-picker-theme-name">
            {(hoveredTheme ?? selectedTheme)?.name ?? ""}
          </span>
        </div>
        <div
          data-slot="theme-picker-theme-grid"
          onMouseLeave={() => {
            setHoveredThemeId(null);
            cancelThemePreview();
          }}
        >
          {sortedThemes.map((t) => {
            const isSelected = t.id === selectedThemeId;
            const preview = () => {
              if (!open && !inline) return;
              setHoveredThemeId(t.id);
              previewTheme(t.id);
            };
            return (
              <button
                key={t.id}
                type="button"
                data-slot="theme-picker-orb"
                data-active={isSelected}
                aria-label={t.name}
                aria-pressed={isSelected}
                title={t.name}
                onClick={() => {
                  setTheme(t.id);
                  cancelPreview();
                  if (!inline) setOpen(false);
                  onThemeSelect?.();
                }}
                onMouseEnter={preview}
                onFocus={preview}
              >
                <ThemeOrb theme={t} isDark={resolvedColorMode === "dark"} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (inline) {
    return (
      <div data-theme-picker="true" data-theme-picker-inline="true">
        <PopoverBody>{themeContent}</PopoverBody>
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setHoveredThemeId(null);
          cancelPreview();
        }
      }}
    >
      <PopoverTrigger asChild>
        {popoverTrigger ?? (
          <Button
            variant="ghost"
            size="normal"
            data-slot="theme-picker-trigger"
            style={
              hideTrigger
                ? { opacity: 0, pointerEvents: "none", position: "absolute" }
                : undefined
            }
            tabIndex={hideTrigger ? -1 : undefined}
            aria-hidden={hideTrigger}
          >
            {triggerLabel}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        collisionPadding={8}
        data-theme-picker="true"
      >
        <PopoverBody>{themeContent}</PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
