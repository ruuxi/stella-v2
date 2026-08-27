import { useEffect } from "react";
import { PhoneAccessBridge } from "./global/mobile/PhoneAccessBridge";
import { AppBootstrap } from "./bootstrap/AppBootstrap";
import { ChatStoreProvider } from "@/context/chat-store";
import { CredentialRequestLayer } from "./global/auth/CredentialRequestLayer";
import { FullShell } from "./shell/FullShell";
import {
  readPetOpenPreference,
  writePetOpenPreference,
} from "./shell/pet/pet-preferences";

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

function App() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (readPetOpenPreference()) {
      window.electronAPI?.pet?.setOpen?.(true);
    }
    const cleanup = window.electronAPI?.pet?.onSetOpen?.((open) => {
      writePetOpenPreference(open);
    });
    return () => cleanup?.();
  }, []);

  return (
    <>
      <div className="app window-full">
        <ChatStoreProvider>
          <AppBootstrap />
          <PhoneAccessBridge />
          <CredentialRequestLayer />
          <FullShell />
        </ChatStoreProvider>
      </div>
    </>
  );
}

export { App };
