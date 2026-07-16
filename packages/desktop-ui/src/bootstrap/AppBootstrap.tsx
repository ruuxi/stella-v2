import { useConversationBootstrap } from "./use-conversation-bootstrap";
import { useStellaBrowserBridgeToast } from "./use-stella-browser-bridge-toast";

export const AppBootstrap = () => {
  // Keep boot light so global startup does not wake the worker immediately.
  useConversationBootstrap();
  useStellaBrowserBridgeToast();

  return null;
};
