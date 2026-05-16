// ─────────────────────────────────────────────────────────────
// PinnedContext — strip above the composer listing files the user
// has pinned for the current session. Pins persist in vscode.setState
// (alongside the timeline) and are prepended to each outgoing prompt
// as `@file` mentions so the agent always picks them up.
// ─────────────────────────────────────────────────────────────

import { motion, AnimatePresence } from "framer-motion";
import { Icon } from "../../design/icons";
import { send } from "../../lib/rpc";

export interface PinnedFile {
  path: string;
  /** Display label (basename + optional line range). */
  label: string;
}

interface PinnedContextProps {
  pins: ReadonlyArray<PinnedFile>;
  onRemove: (path: string) => void;
  onClearAll: () => void;
}

export function PinnedContext({ pins, onRemove, onClearAll }: PinnedContextProps) {
  if (pins.length === 0) return null;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-extrabold tracking-[0.6px] text-accent-glow mr-1">
          <Icon name="attach" size={10} />
          Pinned
        </span>
        <AnimatePresence initial={false}>
          {pins.map((p) => (
            <motion.span
              key={p.path}
              initial={{ opacity: 0, scale: 0.85, y: -2 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: -2 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="inline-flex items-center gap-1.5 px-2 py-[3px] bg-accent-soft border border-accent-mid rounded-md text-[11px] text-t1 font-mono group"
              title={p.path}
            >
              <button
                type="button"
                onClick={() => send({ type: "openFile", path: p.path })}
                className="inline-flex items-center gap-1 bg-transparent border-0 p-0 m-0 cursor-pointer font-[inherit] text-[11px] text-t1 hover:text-accent-glow transition-colors"
              >
                <Icon name="file" size={10} className="text-accent-glow" />
                <span className="font-semibold">{p.label}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(p.path);
                }}
                className="w-3.5 h-3.5 inline-flex items-center justify-center rounded text-t4 hover:text-err hover:bg-err-soft cursor-pointer border-0 bg-transparent font-[inherit] transition-colors"
                aria-label={`Unpin ${p.label}`}
              >
                <Icon name="x" size={8} />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        {pins.length > 1 && (
          <button
            type="button"
            onClick={onClearAll}
            className="ml-1 text-[10px] text-t4 hover:text-t2 transition-colors bg-transparent border-0 cursor-pointer font-[inherit]"
            title="Unpin all"
          >
            Clear
          </button>
        )}
      </div>
    </motion.div>
  );
}
