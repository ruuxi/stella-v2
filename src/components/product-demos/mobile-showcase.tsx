"use client";

import { ArrowUpRight, Wifi } from "lucide-react";
import { StellaMark } from "@/components/stella-mark";

const conversations = [
  {
    id: "organize",
    label: "Organize",
    messages: [
      { role: "user" as const, text: "move my presentation to the second monitor and make it fullscreen" },
      { role: "stella" as const, text: "Done — Q4 Report.pptx is now fullscreen on Display 2." },
      { role: "user" as const, text: "also close all the chrome tabs I left open" },
      { role: "stella" as const, text: "Closed 14 tabs across 2 windows. Your desktop is clear." },
    ],
    desktopAction: "Q4 Report.pptx moved to Display 2",
    desktopDetail: "14 Chrome tabs closed",
  },
  {
    id: "create",
    label: "Create",
    messages: [
      { role: "user" as const, text: "make a playlist folder on my desktop called 'focus' and add my lo-fi bookmarks" },
      { role: "stella" as const, text: "Created the folder and added 8 bookmarks from your lo-fi collection." },
      { role: "user" as const, text: "now play the first one on spotify" },
      { role: "stella" as const, text: "Playing \"midnight rain lofi\" on Spotify. Volume at 35%." },
    ],
    desktopAction: "Spotify — Now Playing",
    desktopDetail: "\"midnight rain lofi\" · Volume 35%",
  },
  {
    id: "research",
    label: "Research",
    messages: [
      { role: "user" as const, text: "find the pdf I downloaded yesterday about neural networks" },
      { role: "stella" as const, text: "Found it — \"Intro_to_Neural_Nets_2024.pdf\" in your Downloads folder. Want me to open it?" },
      { role: "user" as const, text: "yeah and summarize the first 10 pages for me" },
      { role: "stella" as const, text: "Opened the PDF. Here's the summary: The paper covers 3 core architectures…" },
    ],
    desktopAction: "PDF opened in reader",
    desktopDetail: "Summarizing pages 1–10…",
  },
];

export const channels = [{ name: "Stella app", icon: <StellaAppIcon /> }];

/* ── Phone-only visual for section layout ──────────── */

export type Platform = "stella";

export const PLATFORMS: Platform[] = ["stella"];

export const PLATFORM_LABELS: Record<Platform, string> = {
  stella: "Stella",
};

export function MobilePhoneVisual({
  activeConvo,
}: {
  activeConvo: number;
  platform?: Platform;
}) {
  const convo = conversations[activeConvo];

  return (
        <div className="mobile-phone-visual">
          <div className="mobile-phone mobile-phone--stella-app">
            <div className="mobile-phone__status-bar">
              <span className="mobile-phone__time">9:41</span>
              <div className="mobile-phone__status-icons">
                <Wifi size={11} />
                <span className="mobile-phone__battery" />
              </div>
            </div>
            <div className="stella-app-chat">
              <div className="stella-app-chat__gradient" />
              {convo.messages.map((msg, i) => (
                <div
                  key={`${convo.id}-${i}`}
                  className={`stella-app-msg stella-app-msg--${msg.role}`}
                >
                  {msg.text}
                </div>
              ))}
            </div>
            <div className="stella-app-composer">
              <span className="stella-app-composer__add">
                <StellaAddIcon />
              </span>
              <span className="stella-app-composer__input">Message Stella</span>
              <span className="stella-app-composer__send">
                <ArrowUpRight size={14} />
              </span>
            </div>
          </div>
        </div>
  );
}

/* ── Stella channel icon ────────────────────────── */

function StellaAppIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
    </svg>
  );
}

/* ── Stella app icon ────────────────────────────── */

function StellaAddIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="5" y2="19" />
      <line x1="5" x2="19" y1="12" y2="12" />
    </svg>
  );
}
