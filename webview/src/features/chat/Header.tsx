// ─────────────────────────────────────────────────────────────
// Slim session header — Forge ForgeSessionHeader. The model and
// permission-mode pickers live in the Composer, per the Forge
// design. The header carries identity + global session actions.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { IconButton, Chip } from "../../design/primitives";
import { send, ConventionsSource, TimelineEvent } from "../../lib/rpc";
import { findMode } from "./constants";
import type { PermissionMode } from "../../lib/rpc";
import { ConventionsStatusPill } from "./ConventionsStatusPill";
import { TokenMeter } from "./TokenMeter";

interface HeaderProps {
  permissionMode: PermissionMode;
  busy: boolean;
  conventions: {
    source: ConventionsSource | null;
    path: string | null;
    relativePath: string | null;
  };
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
  onOpenHistory: () => void;
  onOpenPalette: () => void;
}

export function Header({
  permissionMode,
  busy,
  conventions,
  events,
  streaming,
  onOpenHistory,
  onOpenPalette
}: HeaderProps) {
  const mode = findMode(permissionMode);
  const [newChatTick, setNewChatTick] = useState(0);
  const handleNewChat = () => {
    send({ type: "newSession" });
    setNewChatTick((t) => t + 1);
  };
  return (
    <header
      className="flex items-center justify-between gap-2 px-3 py-[9px] border-b border-b1 bg-gradient-to-b from-s1 to-s1/85 min-h-[46px] flex-shrink-0 backdrop-blur-sm sticky top-0 z-10"
      style={{ boxShadow: "0 1px 0 var(--b1), 0 8px 24px -16px rgba(0,0,0,0.5)" }}
    >
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <motion.div
          className="w-[24px] h-[24px] rounded-[8px] inline-flex items-center justify-center text-white flex-shrink-0 relative"
          style={{
            background:
              "conic-gradient(from 180deg, var(--accent), var(--accent-glow), var(--accent))",
            boxShadow: "0 1px 10px var(--accent-shadow), 0 0 0 1px rgba(255,255,255,0.06) inset"
          }}
          aria-hidden
          whileHover={{ scale: 1.06, rotate: 12 }}
          transition={{ type: "spring", stiffness: 360, damping: 18 }}
        >
          <Icon name="sparkle" size={12} />
        </motion.div>
        <span className="font-bold text-[13.5px] tracking-[-0.3px] text-t1 flex-shrink-0">
          Klaude
        </span>
        <Chip tone="accent" title="Claude Code subscription">
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          subscription
        </Chip>
        <Chip tone="default" title={mode.note}>
          <Icon name={mode.icon} size={10} />
          {mode.short}
        </Chip>
        <ConventionsStatusPill
          source={conventions.source}
          path={conventions.path}
          relativePath={conventions.relativePath}
        />
        {busy && (
          <Chip tone="accent" pulse title="Streaming">
            <motion.span
              className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-current border-r-transparent"
              animate={{ rotate: 360 }}
              transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
            />
            streaming
          </Chip>
        )}
      </div>

      <div className="flex gap-0.5 flex-shrink-0 items-center">
        <TokenMeter events={events} streaming={streaming} />
        <div className="w-px h-4 bg-b1 mx-1" />
        <IconButton
          icon="search"
          title="Command palette (⌘K)"
          size={28}
          onClick={onOpenPalette}
        />
        <IconButton icon="history" title="Chat history" size={28} onClick={onOpenHistory} />
        <motion.button
          key={`new-chat-${newChatTick}`}
          type="button"
          title="New chat"
          aria-label="New chat"
          className="w-7 h-7 rounded-md bg-transparent border-0 p-0 inline-flex items-center justify-center font-[inherit] cursor-pointer text-t3 hover:bg-s3 hover:text-t1 transition-colors relative"
          onClick={handleNewChat}
          whileTap={{ scale: 0.86 }}
          whileHover={{ scale: 1.08 }}
          transition={{ type: "spring", stiffness: 500, damping: 22 }}
        >
          <motion.span
            initial={false}
            animate={
              newChatTick > 0
                ? { rotate: 90, scale: [1, 1.2, 1] }
                : { rotate: 0, scale: 1 }
            }
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="inline-flex"
          >
            <Icon name="plus" size={14} />
          </motion.span>
          {newChatTick > 0 && (
            <motion.span
              key={`ripple-${newChatTick}`}
              className="absolute inset-0 rounded-md pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at center, var(--accent-glow), transparent 70%)"
              }}
              initial={{ opacity: 0.5, scale: 0.6 }}
              animate={{ opacity: 0, scale: 1.6 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
            />
          )}
        </motion.button>
        <div className="w-px h-4 bg-b1 mx-1" />
        <IconButton
          icon="logout"
          title="Sign out of Claude Code"
          size={28}
          onClick={() => send({ type: "claudeLogout" })}
        />
      </div>
    </header>
  );
}
