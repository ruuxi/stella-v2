export type SelfModLevel = "low" | "medium" | "high";

export type SelfModStage = {
  id: SelfModLevel;
  title: string;
  prompt: string;
};
