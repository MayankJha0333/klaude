// ─────────────────────────────────────────────────────────────
// Processing loader. Shown for the whole turn — from submit, through
// the pre-output gap, while text streams, and during tool work —
// until it ends. Mirrors Claude Code's own loader: a bare accent
// sparkle + a cycling status verb + an animated ellipsis. No avatar
// box, so it reads as a lightweight status line rather than a
// message.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Icon } from "../../design/icons";

// Whimsical status verbs, cycled while the model works.
const VERBS = [
  "Pondering",
  "Thinking",
  "Reasoning",
  "Cooking",
  "Noodling",
  "Crafting",
  "Working",
  "Brewing",
  "Mulling",
  "Tinkering"
];

export function ThinkingIndicator() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setIdx((i) => (i + 1) % VERBS.length),
      2600
    );
    return () => window.clearInterval(id);
  }, []);

  const word = VERBS[idx];

  return (
    <motion.div
      className="flex items-center gap-2 py-1"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      aria-live="polite"
      aria-label={`${word}…`}
    >
      <motion.span
        className="inline-flex text-accent"
        animate={{ rotate: 360, opacity: [0.55, 1, 0.55] }}
        transition={{
          rotate: { duration: 3, repeat: Infinity, ease: "linear" },
          opacity: { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
        }}
        aria-hidden
      >
        <Icon name="sparkle" size={15} />
      </motion.span>
      <span className="thinking-shimmer text-[13px] font-medium">{word}</span>
      <span className="thinking-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </motion.div>
  );
}
