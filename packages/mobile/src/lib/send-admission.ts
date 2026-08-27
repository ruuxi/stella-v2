export type SendAdmission = "dispatch" | "queue";

export const admitSend = (sendingRef: { current: boolean }): SendAdmission => {
  if (sendingRef.current) return "queue";
  sendingRef.current = true;
  return "dispatch";
};
