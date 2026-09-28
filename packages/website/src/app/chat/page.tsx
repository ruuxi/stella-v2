import type { Metadata } from "next";
import { ChatFrame } from "./chat-frame";
import { CHAT_FRAME_BOOT_SCRIPT } from "./chat-frame-source";
import styles from "./chat.module.css";

export const metadata: Metadata = {
  title: "Chat with Stella",
  description:
    "Use Stella from the web, with cloud execution and your connected computers.",
  alternates: { canonical: "/chat" },
};

export default function ChatPage() {
  return (
    <main className={styles.shell}>
      <ChatFrame className={styles.app} />
      <script dangerouslySetInnerHTML={{ __html: CHAT_FRAME_BOOT_SCRIPT }} />
    </main>
  );
}
