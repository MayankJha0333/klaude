// ─────────────────────────────────────────────────────────────
// KeyboardHints — overlay listing the extension's shortcuts.
// Triggered by pressing "?" (when not focused in an input). Esc to
// dismiss. Useful for discoverability of Cmd+I / Cmd+U / Shift+Tab
// and the in-webview shortcuts (Cmd+K palette, n new chat).
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";

interface Group {
  label: string;
  rows: Array<{ keys: string[]; desc: string }>;
}

const GROUPS: Group[] = [
  {
    label: "In editor",
    rows: [
      { keys: ["⌘", "I"], desc: "Inline edit at cursor" },
      { keys: ["⌘", "U"], desc: "Send selection to chat" },
      { keys: ["⌘", "⇧", "I"], desc: "Toggle chat panel" }
    ]
  },
  {
    label: "In chat",
    rows: [
      { keys: ["⌘", "K"], desc: "Command palette" },
      { keys: ["⇧", "Tab"], desc: "Cycle permission mode" },
      { keys: ["@"], desc: "Mention a file" },
      { keys: ["↵"], desc: "Send message" },
      { keys: ["⇧", "↵"], desc: "New line" },
      { keys: ["Esc"], desc: "Cancel / close modal" }
    ]
  },
  {
    label: "Navigation",
    rows: [
      { keys: ["?"], desc: "Open this help" },
      { keys: ["⌘", "/"], desc: "Toggle keyboard hints" }
    ]
  }
];

export function KeyboardHints({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-5"
      initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
      animate={{ opacity: 1, backdropFilter: "blur(4px)" }}
      exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
      transition={{ duration: 0.18 }}
      style={{ backgroundColor: "rgba(8,8,12,0.55)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.985 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="w-full max-w-[460px] bg-s1 border border-b2 rounded-2xl overflow-hidden"
        style={{ boxShadow: "0 28px 80px rgba(0,0,0,0.6)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-b1 bg-gradient-to-b from-s1 to-s1/85">
          <div className="flex items-center gap-2.5">
            <span
              className="w-7 h-7 rounded-lg inline-flex items-center justify-center border border-accent-mid"
              style={{
                background:
                  "linear-gradient(135deg, var(--accent-soft), rgba(99,102,241,0.04))",
                color: "var(--accent-glow)",
                boxShadow: "0 2px 10px var(--accent-shadow)"
              }}
            >
              <Icon name="zap" size={13} />
            </span>
            <h2 className="text-[14px] font-bold tracking-[-0.2px] text-t1 m-0">
              Keyboard shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md bg-transparent hover:bg-s2 text-t3 hover:text-t1 cursor-pointer border-0 inline-flex items-center justify-center font-[inherit] transition-colors"
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icon name="x" size={13} />
          </button>
        </div>

        <div className="px-4 py-3 max-h-[60vh] overflow-y-auto bg-s0/40">
          {GROUPS.map((g, gi) => (
            <motion.section
              key={g.label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: gi * 0.05, duration: 0.22 }}
              className="mb-4 last:mb-0"
            >
              <div className="text-[10px] font-extrabold uppercase tracking-[0.7px] text-t4 mb-1.5 px-1">
                {g.label}
              </div>
              <ul className="flex flex-col gap-0.5 list-none p-0 m-0">
                {g.rows.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md hover:bg-s2/60 transition-colors"
                  >
                    <span className="text-[12.5px] text-t2">{r.desc}</span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {r.keys.map((k, ki) => (
                        <kbd
                          key={ki}
                          className="font-mono text-[10.5px] font-semibold px-1.5 py-[2px] rounded-[5px] bg-s2 border border-b2 text-t1 min-w-[18px] text-center leading-none"
                          style={{ boxShadow: "0 1px 0 var(--b1)" }}
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-b1 bg-s1/60 text-[10.5px] text-t4 flex items-center justify-between">
          <span>
            Press{" "}
            <kbd className="font-mono text-[10px] px-1.5 py-[2px] rounded bg-s2 border border-b2 text-t3">
              ?
            </kbd>{" "}
            to toggle
          </span>
          <span>
            <kbd className="font-mono text-[10px] px-1.5 py-[2px] rounded bg-s2 border border-b2 text-t3">
              Esc
            </kbd>{" "}
            to close
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}
