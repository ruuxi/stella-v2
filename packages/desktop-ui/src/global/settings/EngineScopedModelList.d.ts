export type EngineScopedModelOption = {
  id: string;
  label: string;
  description?: string;
  unavailable?: boolean;
};

export type EngineScopedModelListProps = {
  engineLabel: string;
  models: readonly EngineScopedModelOption[];
  value: string;
  onSelect: (modelId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  emptyMessage?: string | null;
  hideHead?: boolean;
  selectedRowExtra?: import("react").ReactNode;
};

export declare function EngineScopedModelList(
  props: EngineScopedModelListProps,
): import("react").ReactNode;
