import { useConversationBootstrap } from "./use-conversation-bootstrap";
import { useStellaBrowserBridgeToast } from "./use-stella-browser-bridge-toast";

export const AppBootstrap = () => {

  useConversationBootstrap();
  useStellaBrowserBridgeToast();

  return null;
};
