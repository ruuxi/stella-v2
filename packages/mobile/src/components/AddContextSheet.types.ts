export type AddContextSheetProps = {
  visible: boolean;
  /** Asks the sheet to close (swipe down, the close button, or a choice). */
  onClose: () => void;
  /** Fires once the sheet is fully off screen, so a picker can open next. */
  onDismissed: () => void;
  /** Omitted when the chat takes no attachments. */
  onCamera?: () => void;
  onPhotos?: () => void;
  onFiles?: () => void;
  readAloud: boolean;
  onReadAloudChange: (next: boolean) => void;
};
