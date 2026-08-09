import { AnimatePresence, motion } from "motion/react";
import { Download } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import "./drop-overlay.css";

type DropOverlayProps = {
  visible: boolean;
  variant?: "surface" | "sidebar";
};

function DropIcon() {
  return <Download size={28} strokeWidth={1.5} />;
}

export function DropOverlay({ visible, variant = "surface" }: DropOverlayProps) {
  const t = useT();
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="drop-overlay"
          className={`drop-overlay drop-overlay--${variant}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="drop-overlay-content">
            <DropIcon />
            <span className="drop-overlay-label">
              {t("app.chat.dropOverlay.label")}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
