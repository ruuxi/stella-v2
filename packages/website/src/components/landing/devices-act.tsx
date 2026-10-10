"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";
import { StellaCharacter } from "./stella-character";
import { ThemeGradient, windowThemeStyle, type WindowThemeKey } from "./window-theme";
import d from "./devices-act.module.css";

const MESSAGES = [
  { me: true, text: "Plan Saturday with the kids" },
  { me: false, text: "Zoo at 10, lunch at Nopa at 12:30, home for naps by 3." },
  { me: true, text: "Running late. Push lunch to 1?" },
  { me: false, text: "Moved to 1:00. Nopa knows." },
  { me: true, text: "Send the plan to Sam" },
  { me: false, text: "Sent, with a map." },
];

const DEVICES = ["computer", "phone", "browser"] as const;
const HOLD_MS = 4200;
const THEMES: WindowThemeKey[] = [
  { id: "dracula", dark: true },
  { id: "nightowl", dark: true },
  { id: "gruvbox", dark: true },
];

export function DevicesAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState(0);
  const [pass, setPass] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      const r = view.getBoundingClientRect();
      const phone = DEVICES[device] === "phone";
      const narrow = r.width < 700;
      const fit = narrow && phone ? Math.min(r.width / 320, r.height / 600) : Math.min(r.width / 680, r.height / 560);
      view.style.setProperty("--fit", String(Math.max(0.4, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    return () => ro.disconnect();
  }, [device]);

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setRunning(entry?.isIntersecting ?? false), {
      threshold: 0.45,
    });
    if (sectionRef.current) io.observe(sectionRef.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!running || prefersReducedMotion()) return;
    const id = window.setTimeout(() => {
      setDevice((v) => (v + 1) % DEVICES.length);
      setPass((v) => v + 1);
    }, HOLD_MS);
    return () => window.clearTimeout(id);
  }, [running, device]);

  const kind = DEVICES[device];
  const shown = (device + 1) * 2;

  return (
    <section ref={sectionRef} className={d.act} data-tone="dark" data-bg="#060609" aria-labelledby="devices-title">
      <div className={d.inner}>
        <div className={d.copy}>
          <h2 id="devices-title" className={d.title}>
            Everywhere <span>you are.</span>
          </h2>
          <p className={d.names} aria-live="polite">
            <span className="visually-hidden">On your computer, your phone and in the browser.</span>
            {DEVICES.map((name, i) => (
              <span key={name} className={d.name} data-on={i === device ? "1" : "0"} aria-hidden="true">
                {name}.
              </span>
            ))}
          </p>
        </div>
        <div ref={viewRef} className={d.view} aria-hidden="true">
          <div className={d.stage} data-device={kind}>
            <div className={d.device}>
              <span className={d.island} />
              <span className={d.notch} />
              <div className={d.screen} style={windowThemeStyle(THEMES[device])}>
                <div className={d.backdrop}>
                  {THEMES.map((theme, i) => (
                    <ThemeGradient key={theme.id} theme={theme} width={200} height={140} on={i === device} />
                  ))}
                </div>
                <div className={d.chrome}>
                  <span className={d.lights}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className={d.tab}>
                    <StellaCharacter size={12} eyeColor="#1c1c21" />
                    Stella
                  </span>
                  <span className={d.url}>stella.sh/chat</span>
                </div>
                <div className={d.phoneStatus}>
                  <b>9:41</b>
                  <i />
                </div>
                <div className={d.app}>
                  <div className={d.appBar}>
                    <span className={d.appLights}>
                      <i />
                      <i />
                      <i />
                    </span>
                    <StellaCharacter size={20} eyeColor="var(--w-bg)" className={d.appMark} />
                  </div>
                  <div className={d.chat} data-pass={pass % 2 ? "a" : "b"} data-first={pass === 0 ? "1" : "0"}>
                    <div className={d.list}>
                      {MESSAGES.map((m, i) => (
                        <p
                          key={i}
                          className={m.me ? d.me : d.her}
                          data-on={i < shown ? "1" : "0"}
                          style={{
                            animationDelay: i >= shown - 2 && device > 0 ? `${900 + (i % 2) * 600}ms` : "0ms",
                          }}
                        >
                          {m.text}
                        </p>
                      ))}
                    </div>
                    <div className={d.compose}>
                      <span>Do anything</span>
                      <i />
                    </div>
                  </div>
                </div>
                <span className={d.homebar} />
              </div>
            </div>
            <div className={d.base}>
              <span />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
