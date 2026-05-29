import { motion } from "framer-motion";
import { useState } from "react";
import { Icon } from "../../design/icons";
import { renderMarkdown } from "./markdown";

interface AssistantMessageProps {
  text: string;
  streaming?: boolean;
  showAvatar?: boolean;
  /** When set, hovering the message shows a "Continue from here" hint that
   *  fires `onContinue(text)` — used to seed the composer with a follow-up
   *  prompt anchored to this assistant turn. */
  onContinue?: (excerpt: string) => void;
}

export function AssistantMessage({
  text,
  streaming,
  showAvatar = true,
  onContinue
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <motion.div
      className="flex items-start gap-2.5 group relative"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {showAvatar && (
        <motion.div
          className="flex-shrink-0 w-[26px] h-[26px] rounded-lg flex items-center justify-center text-[10.5px] font-bold tracking-[0.05em] mt-0.5 text-on-accent bg-gradient-to-br from-accent to-accent-deep"
          style={{ boxShadow: "0 2px 12px var(--accent-shadow)" }}
          animate={
            streaming ? { opacity: [0.7, 1, 0.7] } : { opacity: 1 }
          }
          transition={
            streaming
              ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0 }
          }
        >
          <Icon name="sparkle" size={13} />
        </motion.div>
      )}
      <div className="md flex-1 min-w-0 leading-[1.6] break-words text-[13.5px] pt-1 text-t2">
        {renderMarkdown(text)}
        {streaming && (
          <motion.span
            className="inline-block w-[7px] h-[1em] bg-accent ml-0.5 align-middle rounded-[1px]"
            style={{ boxShadow: "0 0 6px var(--accent-shadow)" }}
            animate={{ opacity: [1, 0, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            aria-hidden
          />
        )}
      </div>
      {!streaming && text.length > 0 && (
        <div className="absolute top-0 right-0 flex items-center gap-1 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100">
          <button
            type="button"
            onClick={copy}
            title={copied ? "Copied" : "Copy"}
            className="inline-flex items-center gap-1 bg-s2 hover:bg-s3 border border-b1 hover:border-b2 text-t3 hover:text-t1 px-1.5 py-[2px] rounded-md cursor-pointer text-[10px] font-semibold font-[inherit] transition-colors"
          >
            <Icon name={copied ? "check" : "copy"} size={9} />
            {copied ? "Copied" : "Copy"}
          </button>
          {onContinue && (
            <button
              type="button"
              onClick={() => onContinue(excerpt(text))}
              title="Continue from here — seed the composer with a follow-up anchored to this message"
              className="inline-flex items-center gap-1 bg-accent-soft hover:bg-accent-mid border border-accent-mid hover:border-accent text-accent-glow hover:text-t1 px-1.5 py-[2px] rounded-md cursor-pointer text-[10px] font-semibold font-[inherit] transition-colors"
            >
              <Icon name="arrow" size={9} />
              Continue
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

function excerpt(text: string): string {
  // Pull the last ~140 chars of plain text, trimmed at a clause boundary, so
  // the seed prompt has tight context without dragging in formatting.
  const flat = text.replace(/`{3}[\s\S]*?`{3}/g, "").replace(/\s+/g, " ").trim();
  const tail = flat.slice(-140);
  const cut = tail.lastIndexOf(". ");
  return cut > 40 ? tail.slice(cut + 2) : tail;
}
