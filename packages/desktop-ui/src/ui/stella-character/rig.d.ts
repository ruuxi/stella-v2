export type StellaCharacterState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "reading"
  | "loading"
  | "generating"
  | "speaking"
  | "uploading"
  | "downloading"
  | "happy"
  | "celebrate"
  | "confused"
  | "sad"
  | "sleeping"
  | "waking"
  | "powering-down";

export type StellaCharacterShape = "star" | "pebble" | "brand" | "orb";

export interface CreateStellaMarkOptions {

  size?: number | null;
  state?: StellaCharacterState;
  shape?: StellaCharacterShape;

  ink?: "aurora" | "vivid";

  flat?: string | null;

  eyeColor?: string;
  glow?: boolean;
  core?: boolean;
  followPointer?: boolean;
  interactive?: boolean;
  paused?: boolean;
}

export interface StellaMarkHandle {
  el: SVGSVGElement;
  readonly state: StellaCharacterState;
  setState(state: StellaCharacterState): void;
  readonly shape: StellaCharacterShape;
  setShape(shape: StellaCharacterShape): void;
  setGaze(p: { x: number; y: number } | null): void;
  sparkle(count?: number): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export function createStellaMark(
  host: HTMLElement,
  opts?: CreateStellaMarkOptions,
): StellaMarkHandle;

export const ACTIVITIES: readonly string[];
export const C: number;
export const VIEWBOX: string;
