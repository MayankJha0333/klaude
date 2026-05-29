// ─────────────────────────────────────────────────────────────
// Inline suggestion shown above the chat composer when the task
// classifier picked a task type with a known marketplace skill
// recommendation and that skill isn't installed yet.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { send } from "../../lib/rpc";

interface SkillSuggestionProps {
  skillId: string;
  skillName: string;
  reason: string;
  taskType: string;
  onDismiss: () => void;
}

const PRIMARY_BTN =
  "px-2.5 py-1.5 rounded-[5px] border border-accent-mid bg-accent text-on-accent text-[11px] font-semibold cursor-pointer font-[inherit] transition-colors hover:bg-accent-deep";
const GHOST_BTN =
  "px-2.5 py-1.5 rounded-[5px] border border-transparent bg-transparent text-t2 text-[11px] cursor-pointer font-[inherit] transition-colors hover:text-t1 hover:bg-s2";

export function SkillSuggestion({
  skillId,
  skillName,
  reason,
  taskType,
  onDismiss
}: SkillSuggestionProps) {
  const handleView = (): void => {
    send({
      type: "openExternal",
      url: `https://claude-plugins.dev/skills?q=${encodeURIComponent(skillName)}`
    });
    onDismiss();
  };

  return (
    <motion.div
      className="flex items-center justify-between gap-3 px-3.5 py-2.5 mx-3.5 my-2 rounded-lg bg-accent-soft border border-accent-mid text-t1 text-[12px] leading-[1.45]"
      role="status"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="flex-1">
        <span className="inline-block px-1.5 py-px mr-1.5 rounded-[4px] bg-s2 border border-b2 text-[10px] font-semibold uppercase tracking-[0.4px]">
          {taskType}
        </span>
        Detected — <strong>{skillName}</strong> recommended for {reason}.
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        <button type="button" className={PRIMARY_BTN} onClick={handleView}>
          View skill
        </button>
        <button
          type="button"
          className={GHOST_BTN}
          onClick={() => {
            send({ type: "dismissSkillSuggestion", skillId });
            onDismiss();
          }}
        >
          Don't suggest again
        </button>
        <button type="button" className={GHOST_BTN} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </motion.div>
  );
}
