export interface ProviderOption {
  key: string;
  label: string;
  description?: string;
}

export type ProviderOnlyPickerProps = {
  providers: readonly ProviderOption[];
  value: string;
  onSelect: (providerKey: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
};

export declare function ProviderOnlyPicker(
  props: ProviderOnlyPickerProps,
): import("react").ReactNode;
