import type {
  ButtonHTMLAttributes,
  ForwardRefExoticComponent,
  JSX,
  RefAttributes,
  TextareaHTMLAttributes,
} from "react";

type ComposerButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
type ComposerForwardButton = ForwardRefExoticComponent<
  ComposerButtonProps & RefAttributes<HTMLButtonElement>
>;

export const ComposerAddButton: ComposerForwardButton;
export const ComposerStopButton: ComposerForwardButton;
export const ComposerMicButton: ForwardRefExoticComponent<
  ComposerButtonProps &
    { isTranscribing?: boolean } &
    RefAttributes<HTMLButtonElement>
>;
export const ComposerRealtimeVoiceButton: ForwardRefExoticComponent<
  ComposerButtonProps & { active?: boolean } & RefAttributes<HTMLButtonElement>
>;
export function ComposerSubmitButton(
  props: ComposerButtonProps & { animated?: boolean },
): JSX.Element;
export const ComposerTextarea: ForwardRefExoticComponent<
  TextareaHTMLAttributes<HTMLTextAreaElement> &
    { tone?: "default" | "orb" } &
    RefAttributes<HTMLTextAreaElement>
>;
