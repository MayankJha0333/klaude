import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { send } from "../../lib/rpc";
import type { EditorContext } from "../../lib/rpc";

interface ContextStripProps {
  context: EditorContext | null;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}

export function ContextStrip({ context, pinned, onPin, onUnpin }: ContextStripProps) {
  if (!context) return null;
  const fileName = context.file.split("/").pop() ?? context.file;
  const sel = context.selection;
  return (
    <motion.div
      className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5 pb-0.5"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={() =>
          send({
            type: "openFile",
            path: context.file,
            startLine: sel?.startLine ?? 0,
            endLine: sel?.endLine ?? 0
          })
        }
        className="inline-flex items-center gap-1.5 px-2.5 py-[4px] bg-s2 border border-b1 rounded-md text-[11px] text-t1 font-mono cursor-pointer transition-colors hover:bg-s3 hover:border-b2 font-[inherit]"
        title={`Open ${context.file}`}
      >
        <Icon name="file" size={11} className="text-accent-glow" />
        <span className="font-semibold text-t1 font-mono">{fileName}</span>
        <span className="text-t3 text-[10px] border-l border-b1 ml-0.5 pl-1.5 uppercase tracking-[0.3px] font-mono">
          {context.language}
        </span>
      </button>
      {sel && (
        <span className="inline-flex items-center gap-1 px-2 py-[3px] bg-accent-soft border border-accent-mid rounded-md text-[10.5px] text-accent-glow font-mono font-semibold">
          <Icon name="code" size={10} />
          L{sel.startLine}
          {sel.endLine !== sel.startLine && `–${sel.endLine}`}
        </span>
      )}
      <button
        type="button"
        onClick={pinned ? onUnpin : onPin}
        title={pinned ? "Unpin from session" : "Pin to session context"}
        aria-label={pinned ? "Unpin file" : "Pin file"}
        className={[
          "inline-flex items-center gap-1 px-2 py-[3px] rounded-md text-[10.5px] font-semibold cursor-pointer transition-colors font-[inherit] border",
          pinned
            ? "bg-accent-soft border-accent-mid text-accent-glow hover:bg-accent-soft/80"
            : "bg-transparent border-transparent text-t4 hover:text-t2 hover:bg-s2 hover:border-b1"
        ].join(" ")}
      >
        <Icon name="attach" size={10} />
        {pinned ? "Pinned" : "Pin"}
      </button>
    </motion.div>
  );
}
