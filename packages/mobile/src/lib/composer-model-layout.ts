export function resolveComposerExpanded({
  expanded,
  dictationBelow,
  dictationInline,
  modelPickerPinned,
  hasAttachments = false,
}: {
  expanded: boolean;
  dictationBelow: boolean;
  dictationInline: boolean;
  modelPickerPinned: boolean;
  /**
   * Attachments render inside the composer above the text, so the shell
   * takes its expanded (toolbar) shape whenever any are pending.
   */
  hasAttachments?: boolean;
}): boolean {
  return (
    expanded ||
    dictationBelow ||
    hasAttachments ||
    (modelPickerPinned && !dictationInline)
  );
}
