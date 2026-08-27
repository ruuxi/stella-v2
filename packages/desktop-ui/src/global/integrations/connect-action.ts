export const OPEN_CONNECT_DIALOG_EVENT = "stella:open-connect";

export const openConnectDialog = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_CONNECT_DIALOG_EVENT));
};
