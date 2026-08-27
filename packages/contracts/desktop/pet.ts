export type PetAnimationState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type PetOverlayState =
  | "idle"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "waving";

export type PetOverlayStatus = {

  state: PetOverlayState;

  title: string;

  message: string;

  isLoading: boolean;
};
