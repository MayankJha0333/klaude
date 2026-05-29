import { useEffect } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";

interface RewindModalProps {
  messagesAfter: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RewindModal({ messagesAfter, onCancel, onConfirm }: RewindModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

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
        className="w-[420px] max-w-[92vw] rounded-xl bg-s1 border border-b2 shadow-[0_24px_60px_rgba(0,0,0,0.55)] p-5"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.94, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.94, opacity: 0 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="w-9 h-9 rounded-[10px] bg-accent-soft text-accent-glow inline-flex items-center justify-center mb-3.5">
          <Icon name="history" size={20} />
        </div>
        <h2 className="text-[15px] font-bold text-t1 m-0 mb-1.5">
          Rewind conversation?
        </h2>
        <p className="text-[12.5px] leading-[1.5] text-t2 m-0 mb-[18px]">
          {messagesAfter > 0
            ? `This will remove ${messagesAfter} message${messagesAfter !== 1 ? "s" : ""} after this point and restore any files that were changed.`
            : "This will rewind to this point and restore any files that were changed."}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md bg-s2 border border-b2 text-t2 text-[12px] font-semibold font-[inherit] cursor-pointer transition-colors duration-[120ms] hover:text-t1 hover:bg-s3 hover:border-b3"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md bg-accent border border-accent-mid text-on-accent text-[12px] font-semibold font-[inherit] cursor-pointer transition-colors duration-[120ms] hover:bg-accent-deep"
            onClick={onConfirm}
            autoFocus
          >
            Rewind
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
