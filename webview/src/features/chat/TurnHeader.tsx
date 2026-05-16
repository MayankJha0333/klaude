// ─────────────────────────────────────────────────────────────
// TurnHeader — small "Worked for Xm Ys" banner shown above each
// assistant turn. Antigravity-style. Click to collapse the entire
// turn body.
// ─────────────────────────────────────────────────────────────

import { Icon } from "../../design/icons";
import { formatDuration } from "./tool-buckets";

interface TurnHeaderProps {
  workedMs?: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function TurnHeader({ workedMs, collapsed, onToggle }: TurnHeaderProps) {
  const live = workedMs === undefined;
  const label = live ? "Working…" : `Worked for ${formatDuration(workedMs!)}`;
  return (
    <div className="sticky top-[-1px] z-[2] -mx-2 px-2 py-0.5 backdrop-blur-md bg-s0/85 rounded-md">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 px-1.5 py-0.5 mb-0.5 -ml-0.5 bg-transparent border-0 rounded-md cursor-pointer text-t3 font-[inherit] text-[11px] font-semibold tracking-[0.1px] transition-colors duration-[120ms] hover:text-t2 hover:bg-s2/60"
        onClick={onToggle}
      >
        {live && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-accent"
            style={{
              boxShadow: "0 0 8px var(--accent-shadow)",
              animation: "forgePulse 1.4s ease-in-out infinite"
            }}
          />
        )}
        <span>{label}</span>
        <span className="inline-flex opacity-60">
          <Icon name={collapsed ? "chevronR" : "chevronD"} size={10} />
        </span>
      </button>
    </div>
  );
}
