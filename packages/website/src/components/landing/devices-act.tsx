"use client";

import { useEffect, useRef, useState } from "react";
import { StellaMark } from "@/components/stella-mark";
import { prefersReducedMotion } from "./scroll-engine";
import d from "./devices-act.module.css";

const MESSAGES = [
  { me: true, text: "Plan Saturday with the kids" },
  { me: false, text: "Zoo at 10, lunch at Nopa at 12:30, home for naps by 3." },
  { me: true, text: "Running late. Push lunch to 1?" },
  { me: false, text: "Moved to 1:00. Nopa knows." },
  { me: true, text: "Send the plan to Sam" },
  { me: false, text: "Sent, with a map." },
];

const DEVICES = ["Mac", "iPhone", "Browser"];

export function DevicesAct() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState(0);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      const r = view.getBoundingClientRect();
      const narrow = r.width < 700;
      const fit = narrow
        ? Math.min(r.height / 880, r.width / 400)
        : Math.min(r.height / 880, r.width / 1040);
      stageRef.current?.style.setProperty("--fit", String(fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    const io = new IntersectionObserver(([entry]) => setRunning(entry?.isIntersecting ?? false), {
      threshold: 0.45,
    });
    if (sectionRef.current) io.observe(sectionRef.current);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running || prefersReducedMotion()) return;
    const id = window.setTimeout(() => setDevice((d) => (d + 1) % DEVICES.length), 4200);
    return () => window.clearTimeout(id);
  }, [running, device, tick]);

  const shown = (device + 1) * 2;

  return (
    <section
      ref={sectionRef}
      className={d.act}
      data-tone="dark"
      data-bg="#060609"
      aria-labelledby="devices-title"
    >
      <div className={d.sticky}>
        <h2 id="devices-title" className={d.title}>
          Everywhere <span>you are.</span>
        </h2>
        <div ref={viewRef} className={d.view} aria-hidden="true">
          <div ref={stageRef} className={d.stage}>
            <div
              data-on={device === 0 ? "1" : "0"}
              className={`${d.frame} ${d.mac}`}
            >
              <div className={d.macScreen}>
                <span className={d.notch} />
                <div className={d.macDesk}>
                  <span className={d.macSide}>
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
              <div className={d.macBase}>
                <span />
              </div>
            </div>
            <div
              data-on={device === 1 ? "1" : "0"}
              className={`${d.frame} ${d.phone}`}
            >
              <div className={d.phoneScreen}>
                <span className={d.island} />
                <span className={d.status}>
                  <b>9:41</b>
                  <i />
                </span>
                <span className={d.homebar} />
              </div>
            </div>
            <div
              data-on={device === 2 ? "1" : "0"}
              className={`${d.frame} ${d.browser}`}
            >
              <div className={d.browserTop}>
                <span className={d.lights}>
                  <i />
                  <i />
                  <i />
                </span>
                <span className={d.btab}>
                  <StellaMark size={12} />
                  Stella
                </span>
              </div>
              <div className={d.burl}>stella.sh/chat</div>
            </div>

            <div className={d.chat}>
              <div className={d.chatHead}>
                <StellaMark size={18} />
                <b>Stella</b>
              </div>
              <div className={d.chatWin}>
                <div className={d.list}>
                  {MESSAGES.map((m, i) => (
                    <p
                      key={i}
                      className={m.me ? d.me : d.her}
                      data-on={i < shown ? "1" : "0"}
                      style={{
                        transitionDelay: i >= shown - 2 && device > 0 ? `${450 + (i % 2) * 650}ms` : "0ms",
                      }}
                    >
                      {m.text}
                    </p>
                  ))}
                </div>
              </div>
              <div className={d.compose}>Do anything</div>
            </div>
          </div>
        </div>
        <div className={d.labels} role="tablist" aria-label="Devices">
          {DEVICES.map((name, i) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={device === i}
              data-on={device === i ? "1" : "0"}
              onClick={() => {
                setDevice(i);
                setTick((t) => t + 1);
              }}
            >
              {name}
            </button>
          ))}
          <span>Windows</span>
          <span>Linux</span>
          <span>Android</span>
        </div>
      </div>
    </section>
  );
}
