import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";

export function SettingsToggleCard({
  title,
  description,
  error,
  checked,
  disabled,
  onChange,
  retry,
  retryLabel,
}: {
  title: string;
  description: string;
  error: string | null;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  retry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">{title}</h3>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(Boolean(next))}
          hideLabel
        />
      </div>
      <p className="settings-card-desc">{description}</p>
      {error ? (
        <>
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {error}
          </p>
          {retry && retryLabel ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={retry}
            >
              {retryLabel}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
