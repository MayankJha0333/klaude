// ─────────────────────────────────────────────────────────────
// HistoryDrawer — slide-in panel listing prior chat sessions.
// Features:
//   • Search by title (live filter, debounced via React batching).
//   • Sessions grouped by relative-time bucket ("Today", "Yesterday",
//     "Last 7 days", "This month", "Earlier").
//   • Empty/loading/no-match states.
//   • Smooth slide-in via Framer Motion, with staggered row entrance.
//   • Delete-with-undo via inline two-step confirm.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { send, onMessage, HistoryEntry } from "../../lib/rpc";

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function HistoryDrawer({ open, onClose, onSelect }: HistoryDrawerProps) {
  const [sessions, setSessions] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "historyList") setSessions(m.sessions);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmId(null);
      return;
    }
    setSessions(null);
    send({ type: "requestHistory" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!sessions) return null;
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  const grouped = useMemo(() => groupByBucket(filtered ?? []), [filtered]);

  const handleDelete = (id: string) => {
    if (confirmId === id) {
      send({ type: "deleteHistoryEntry", id });
      setConfirmId(null);
    } else {
      setConfirmId(id);
      setTimeout(() => {
        setConfirmId((curr) => (curr === id ? null : curr));
      }, 2400);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="drawer-backdrop"
          className="fixed inset-0 z-[900] flex justify-end"
          initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
          animate={{ opacity: 1, backdropFilter: "blur(4px)" }}
          exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Chat history"
        >
          <motion.aside
            key="drawer-panel"
            initial={{ x: 60, opacity: 0, scale: 0.985 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: 60, opacity: 0, scale: 0.99, transition: { duration: 0.18, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.85 }}
            className="w-[min(380px,100vw)] h-full bg-s1 border-l border-b2 flex flex-col"
            style={{
              boxShadow: "-16px 0 56px rgba(0,0,0,0.5), -2px 0 0 var(--b2)",
              transformOrigin: "right center"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <header className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-b1 bg-gradient-to-b from-s1 to-s1/85 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <motion.span
                  className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--accent-soft), rgba(99,102,241,0.04))",
                    border: "1px solid var(--accent-mid)",
                    color: "var(--accent-glow)",
                    boxShadow: "0 2px 10px var(--accent-shadow)"
                  }}
                  initial={{ scale: 0.85, rotate: -12 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.05, type: "spring", stiffness: 340, damping: 22 }}
                >
                  <Icon name="history" size={13} />
                </motion.span>
                <h2 className="text-[14px] font-bold tracking-[-0.2px] text-t1 m-0">
                  Chat history
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close (Esc)"
                title="Close (Esc)"
                className="w-8 h-8 rounded-md bg-transparent hover:bg-s2 text-t3 hover:text-t1 cursor-pointer border-0 inline-flex items-center justify-center font-[inherit] transition-colors"
              >
                <Icon name="x" size={13} />
              </button>
            </header>

            {/* Search */}
            <div className="px-4 pt-3 pb-2 flex-shrink-0">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t4 pointer-events-none">
                  <Icon name="search" size={12} />
                </span>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats…"
                  className="w-full bg-s0 border border-b1 hover:border-b2 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] rounded-lg pl-8 pr-7 py-1.5 text-[12.5px] text-t1 placeholder:text-t4 font-[inherit] transition-[border-color,box-shadow] outline-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded inline-flex items-center justify-center bg-transparent hover:bg-s2 text-t4 hover:text-t1 cursor-pointer border-0 font-[inherit]"
                    aria-label="Clear search"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {sessions === null && <LoadingState />}
              {sessions !== null && sessions.length === 0 && (
                <EmptyState title="No previous chats yet" sub="Start a conversation — it'll appear here." />
              )}
              {sessions !== null && sessions.length > 0 && grouped.length === 0 && (
                <EmptyState
                  title="No matches"
                  sub={`Nothing matched "${query}". Try a different keyword.`}
                />
              )}

              {grouped.map((group, gi) => (
                <motion.section
                  key={group.label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 * gi, duration: 0.2 }}
                  className="mb-2"
                >
                  <div className="px-2 pt-2 pb-1 text-[10px] font-extrabold uppercase tracking-[0.8px] text-t4">
                    {group.label}
                  </div>
                  <ul className="flex flex-col gap-0.5 list-none p-0 m-0">
                    {group.items.map((s, i) => (
                      <motion.li
                        key={s.id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.04 * gi + 0.025 * i, duration: 0.2 }}
                      >
                        <HistoryItem
                          session={s}
                          onSelect={() => onSelect(s.id)}
                          onDelete={() => handleDelete(s.id)}
                          confirming={confirmId === s.id}
                        />
                      </motion.li>
                    ))}
                  </ul>
                </motion.section>
              ))}
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-b1 bg-s1/60 flex items-center justify-between text-[10.5px] text-t4 flex-shrink-0">
              <span>
                {sessions ? sessions.length : 0}{" "}
                {sessions && sessions.length === 1 ? "chat" : "chats"} total
              </span>
              <span>
                <kbd className="font-mono text-[10px] px-1.5 py-[2px] rounded bg-s2 border border-b2 text-t3">
                  Esc
                </kbd>
                <span className="ml-1.5">to close</span>
              </span>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────── Sub-components ───────────────────

function HistoryItem({
  session,
  onSelect,
  onDelete,
  confirming
}: {
  session: HistoryEntry;
  onSelect: () => void;
  onDelete: () => void;
  confirming: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="group flex items-center gap-2 px-2.5 py-2 rounded-lg border border-transparent hover:border-b1 hover:bg-s2/60 active:bg-s3 cursor-pointer transition-[background,border-color,transform] duration-[120ms] focus:outline-none focus-visible:border-accent-mid focus-visible:bg-accent-soft/30"
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-t4 group-hover:bg-accent transition-colors"
        aria-hidden
      />
      <div className="flex-1 min-w-0 flex flex-col gap-[1px]">
        <span className="text-[12.5px] font-semibold text-t1 truncate tracking-[-0.05px]">
          {session.title || "Untitled chat"}
        </span>
        <span className="text-[10.5px] text-t4 font-mono flex items-center gap-1.5">
          <span>{formatRelativeTime(session.updatedAt)}</span>
          <span className="text-t4/60">·</span>
          <span>
            {session.eventCount} {session.eventCount === 1 ? "event" : "events"}
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={[
          "w-6 h-6 rounded-md inline-flex items-center justify-center flex-shrink-0 cursor-pointer border bg-transparent font-[inherit] transition-all duration-[140ms]",
          confirming
            ? "opacity-100 text-err border-err bg-err-soft scale-105"
            : "opacity-0 group-hover:opacity-100 text-t4 hover:text-err border-transparent hover:bg-err-soft hover:border-[rgba(248,113,113,0.35)]"
        ].join(" ")}
        aria-label={confirming ? "Confirm delete" : "Delete chat"}
        title={confirming ? "Click again to confirm" : "Delete chat"}
      >
        <Icon name={confirming ? "check" : "x"} size={10} />
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-lg bg-s2/50 px-2.5 py-2 flex items-center gap-2"
          style={{ animation: `forgePulse 1.6s ease-in-out infinite ${i * 0.08}s` }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-b2" />
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="h-[10px] rounded bg-b2" style={{ width: `${60 + i * 8}%` }} />
            <span className="h-[8px] rounded bg-b1" style={{ width: `${30 + i * 4}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05, duration: 0.24 }}
      className="text-center py-12 px-6"
    >
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-s2 border border-b1 text-t4 mb-3">
        <Icon name="history" size={18} />
      </div>
      <div className="text-[13px] font-semibold text-t2">{title}</div>
      <div className="text-[11.5px] text-t4 mt-1 leading-[1.4]">{sub}</div>
    </motion.div>
  );
}

// ─────────────────── Helpers ───────────────────

interface Bucket {
  label: string;
  items: HistoryEntry[];
}

function groupByBucket(sessions: HistoryEntry[]): Bucket[] {
  if (sessions.length === 0) return [];
  const now = Date.now();
  const oneDay = 86_400_000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - oneDay;
  const sevenDaysAgo = today - 7 * oneDay;
  const thirtyDaysAgo = today - 30 * oneDay;

  const buckets: Record<string, HistoryEntry[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    "This month": [],
    Earlier: []
  };

  for (const s of sessions) {
    const t = s.updatedAt;
    if (t >= today) buckets["Today"].push(s);
    else if (t >= yesterday) buckets["Yesterday"].push(s);
    else if (t >= sevenDaysAgo) buckets["Last 7 days"].push(s);
    else if (t >= thirtyDaysAgo) buckets["This month"].push(s);
    else buckets["Earlier"].push(s);
  }

  const order = ["Today", "Yesterday", "Last 7 days", "This month", "Earlier"];
  return order
    .map((label) => ({ label, items: buckets[label] }))
    .filter((b) => b.items.length > 0);
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 30_000) return "just now";
  if (diff < min) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
