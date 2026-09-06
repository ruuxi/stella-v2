export function resolveComposerExpanded({
  expanded,
  dictationBelow,
  dictationInline,
  modelPickerPinned,
  hasAttachments = false,
}: {
  expanded: boolean;
  /** Dictation running underneath typed text. */
  dictationBelow: boolean;
  /**
   * Dictation running in an otherwise empty composer. The live transcript
   * takes the text area and the waveform row sits underneath it, so the
   * shell needs the expanded (rounded rectangle) shape rather than a pill
   * that would stretch to fit both.
   */
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
    dictationInline ||
    hasAttachments ||
    modelPickerPinned
  );
}
