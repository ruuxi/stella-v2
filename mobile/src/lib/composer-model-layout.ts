export function resolveComposerExpanded({
  expanded,
  dictationBelow,
  dictationInline,
  modelPickerPinned,
}: {
  expanded: boolean;
  dictationBelow: boolean;
  dictationInline: boolean;
  modelPickerPinned: boolean;
}): boolean {
  return expanded || dictationBelow || (modelPickerPinned && !dictationInline);
}
