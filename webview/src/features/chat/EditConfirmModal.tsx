// ─────────────────────────────────────────────────────────────
// Confirmation modal for edit-and-resubmit. Editing a past
// message ALWAYS discards everything that came after it (a
// fresh conversation branch starts from this point); the only
// question is whether the workspace files should also revert
// to the snapshot taken when this message was originally sent.
//
// Three outcomes:
//   • Cancel       (Esc)     — close the modal, keep editing
//   • Don't revert (⇧↵)      — discard messages, leave files
//   • Revert       (↵)       — discard messages AND restore files
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";

interface EditConfirmModalProps {
  messagesAfter: number;
  onCancel: () => void;
  onDontRevert: () => void;
  onRevert: () => void;
}

export function EditConfirmModal({
  messagesAfter,
  onCancel,
  onDontRevert,
  onRevert
}: EditConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onDontRevert();
        else onRevert();
      }
    };
    // Defer registration to the next frame so the in-flight keydown that
    // *opened* this modal (the Enter pressed in the inline editor) has
    // fully propagated and won't immediately trigger Revert. Without this,
    // the modal would auto-confirm on the same Enter that submitted.
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      window.addEventListener("keydown", onKey);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel, onDontRevert, onRevert]);

  const clearedClause =
    messagesAfter > 0
      ? ` and clear the ${messagesAfter} message${messagesAfter !== 1 ? "s" : ""} after this one`
      : "";
  const body = `Submitting from a previous message will revert file changes to before this message${clearedClause}.`;

  return (
    <motion.div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/55 backdrop-blur-[2px]"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      <motion.div
        className="w-[460px] max-w-[92vw] rounded-xl bg-s1 border border-b2 shadow-[0_24px_60px_rgba(0,0,0,0.55)] p-5"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.94, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.94, opacity: 0 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      >
        <h2 className="text-[15px] font-bold text-t1 m-0 mb-1.5">
          Submit from a previous message?
        </h2>
        <p className="text-[12.5px] leading-[1.5] text-t2 m-0 mb-[18px]">{body}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-2.5 py-1.5 rounded-md bg-transparent border border-transparent text-t2 text-[12px] font-semibold font-[inherit] cursor-pointer transition-colors duration-[120ms] hover:text-t1 hover:bg-s2"
            onClick={onCancel}
          >
            Cancel <span className="ml-1.5 text-[11px] font-mono opacity-70 font-medium">(esc)</span>
          </button>
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md bg-s2 border border-b2 text-t1 text-[12px] font-semibold font-[inherit] cursor-pointer transition-colors duration-[120ms] hover:bg-s3 hover:border-b3"
            onClick={onDontRevert}
          >
            Don't revert
            <span className="ml-1.5 text-[11px] font-mono opacity-70 font-medium">⇧↵</span>
          </button>
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md bg-accent border border-accent-mid text-on-accent text-[12px] font-semibold font-[inherit] cursor-pointer transition-colors duration-[120ms] hover:bg-accent-deep"
            onClick={onRevert}
          >
            Revert <span className="ml-1.5 text-[11px] font-mono text-on-accent/85 font-medium">↵</span>
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
