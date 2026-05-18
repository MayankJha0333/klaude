// ─────────────────────────────────────────────────────────────
// Banner — shown after 3 turns in a workspace with no conventions
// file detected. Three actions: Generate (opens command), Not now
// (hides for this session), or Don't ask again (workspace-scoped).
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { send } from "../../lib/rpc";

interface ConventionsBannerProps {
  onHideForSession: () => void;
}

const PRIMARY_BTN =
  "px-2.5 py-1.5 rounded-[5px] border border-accent-mid bg-accent text-white text-[11px] font-semibold cursor-pointer font-[inherit] transition-colors hover:bg-accent-deep";
const GHOST_BTN =
  "px-2.5 py-1.5 rounded-[5px] border border-transparent bg-transparent text-t2 text-[11px] cursor-pointer font-[inherit] transition-colors hover:text-t1 hover:bg-s2";

export function ConventionsBanner({ onHideForSession }: ConventionsBannerProps) {
  return (
    <motion.div
      className="flex items-center justify-between gap-3 px-3.5 py-2.5 mx-3.5 my-2 rounded-lg bg-accent-soft border border-accent-mid text-t1 text-[12px] leading-[1.45]"
      role="status"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="flex-1">
        <strong>Klaude works better with project conventions.</strong>
        <span>
          {" "}
          Generate a CLAUDE.md so the model knows your project's structure,
          style, and canonical examples.
        </span>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        <button
          type="button"
          className={PRIMARY_BTN}
          onClick={() => {
            send({ type: "generateConventions" });
            onHideForSession();
          }}
        >
          Generate
        </button>
        <button type="button" className={GHOST_BTN} onClick={onHideForSession}>
          Not now
        </button>
        <button
          type="button"
          className={GHOST_BTN}
          onClick={() => {
            send({ type: "dismissConventionsBanner" });
            onHideForSession();
          }}
        >
          Don't ask for this workspace
        </button>
      </div>
    </motion.div>
  );
}
