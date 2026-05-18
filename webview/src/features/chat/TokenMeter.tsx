// ─────────────────────────────────────────────────────────────
// TokenMeter — header chip + popover modeled on Claude's official
// "Usage" settings page (Current session + Weekly limits + Last
// updated). Data is aggregated from Claude Code's per-workspace
// session JSONL files when available (subscription mode); falls
// back to a client-side chars/4 estimate otherwise.
//
// Limits are plan-specific (Pro / Max 5× / Max 20× / Team) because
// Anthropic doesn't expose the user's real quota to clients. The
// user picks their plan once; we keep sensible defaults for each.
// When usage exceeds the configured plan limit (most often because
// the limit is set too low for the user's tier), the row switches
// to a soft "above plan default — adjust?" pill instead of locking
// the bar at a misleading 100% red.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Icon } from "../../design/icons";
import { onMessage, send } from "../../lib/rpc";
import type {
  TimelineEvent,
  UsageTotals,
  SessionWindow,
  RateLimitInfo
} from "../../lib/rpc";

interface TokenMeterProps {
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
}

// Plan presets — rough estimates of Anthropic's published per-plan caps.
// Anthropic doesn't broadcast these to clients, so we ship the best
// publicly-documented numbers and let the user override anything that
// doesn't match their actual experience.
type PlanKey = "pro" | "max5" | "max20" | "team" | "api" | "custom";

interface PlanPreset {
  name: string;
  /** Tokens per 5-hour rolling window. 0 = no cap (API). */
  session: number;
  /** Cumulative tokens per week, across every model. 0 = no cap. */
  weekAll: number;
  /** Cumulative tokens per week, Sonnet only. 0 = no cap. */
  weekSonnet: number;
  /** Short note shown under the plan name in the picker. */
  note: string;
}

const PLAN_PRESETS: Record<PlanKey, PlanPreset> = {
  pro: {
    name: "Pro",
    session: 200_000,
    weekAll: 10_000_000,
    weekSonnet: 3_000_000,
    note: "Personal tier"
  },
  max5: {
    name: "Max 5×",
    session: 1_500_000,
    weekAll: 50_000_000,
    weekSonnet: 20_000_000,
    note: "5× the Pro quota"
  },
  max20: {
    name: "Max 20×",
    session: 6_000_000,
    weekAll: 200_000_000,
    weekSonnet: 80_000_000,
    note: "20× the Pro quota"
  },
  team: {
    name: "Team",
    session: 10_000_000,
    weekAll: 500_000_000,
    weekSonnet: 200_000_000,
    note: "Per-seat business plan"
  },
  api: {
    name: "API",
    session: 0,
    weekAll: 0,
    weekSonnet: 0,
    note: "No subscription cap — billed per token"
  },
  custom: {
    name: "Custom",
    session: 200_000,
    weekAll: 5_000_000,
    weekSonnet: 2_000_000,
    note: "Set your own limits"
  }
};

const PLAN_ORDER: PlanKey[] = ["pro", "max5", "max20", "team", "api", "custom"];

const SETTINGS_KEY = "klaude.tokenMeter.v3";

interface MeterSettings {
  plan: PlanKey;
  /** Custom overrides keyed by plan (so editing Pro limits doesn't bleed into Max). */
  overrides: Partial<Record<PlanKey, { session?: number; weekAll?: number; weekSonnet?: number }>>;
}

function defaultSettings(): MeterSettings {
  return { plan: "pro", overrides: {} };
}

function readSettings(): MeterSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<MeterSettings>;
    return {
      plan: PLAN_ORDER.includes(parsed.plan as PlanKey)
        ? (parsed.plan as PlanKey)
        : "pro",
      overrides:
        parsed.overrides && typeof parsed.overrides === "object"
          ? (parsed.overrides as MeterSettings["overrides"])
          : {}
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(s: MeterSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

function resolveLimits(s: MeterSettings): {
  session: number;
  weekAll: number;
  weekSonnet: number;
} {
  const preset = PLAN_PRESETS[s.plan];
  const ov = s.overrides[s.plan] ?? {};
  return {
    session: ov.session ?? preset.session,
    weekAll: ov.weekAll ?? preset.weekAll,
    weekSonnet: ov.weekSonnet ?? preset.weekSonnet
  };
}

const EMPTY_TOTAL: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreatedTokens: 0,
  messages: 0
};

const EMPTY_SESSION: SessionWindow = {
  usage: EMPTY_TOTAL,
  startedAt: 0,
  resetsAt: 0
};

interface AuthoritativeUsage {
  session: SessionWindow;
  today: UsageTotals;
  week: UsageTotals;
  weekSonnet: UsageTotals;
  total: UsageTotals;
  generatedAt: number;
  available: boolean;
}

export function TokenMeter({ events, streaming }: TokenMeterProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<MeterSettings>(() => readSettings());
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [auth, setAuth] = useState<AuthoritativeUsage>({
    session: EMPTY_SESSION,
    today: EMPTY_TOTAL,
    week: EMPTY_TOTAL,
    weekSonnet: EMPTY_TOTAL,
    total: EMPTY_TOTAL,
    generatedAt: 0,
    available: false
  });
  // Live rate-limit info from Anthropic's response headers, when API mode
  // is in use. This is server-truth — the exact numbers Anthropic uses to
  // enforce quota — so the meter prefers it over plan presets when present.
  const [serverLimit, setServerLimit] = useState<RateLimitInfo | null>(null);
  const [serverLimitAt, setServerLimitAt] = useState<number>(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, [open]);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "claudeCodeUsage") {
        setAuth({
          session: m.session,
          today: m.today,
          week: m.week,
          weekSonnet: m.weekSonnet,
          total: m.total,
          generatedAt: m.generatedAt,
          available: m.available
        });
      } else if (m.type === "tokenUsage" && m.rateLimit) {
        setServerLimit(m.rateLimit);
        setServerLimitAt(Date.now());
      }
    });
  }, []);

  const sessionEstimate = useMemo(
    () => estimateSession(events, streaming),
    [events, streaming]
  );

  const limits = resolveLimits(settings);
  const preset = PLAN_PRESETS[settings.plan];

  const sessionTotal = auth.available
    ? totalOf(auth.session.usage)
    : sessionEstimate.input + sessionEstimate.output;
  const weekAllTotal = totalOf(auth.week);
  const weekSonnetTotal = totalOf(auth.weekSonnet);

  const sessionPct = pctOf(sessionTotal, limits.session);
  const weekAllPct = pctOf(weekAllTotal, limits.weekAll);
  const weekSonnetPct = pctOf(weekSonnetTotal, limits.weekSonnet);

  // For the chip: show whichever bucket has the highest pressure. If the
  // currently-active plan has no caps (API) just show session total.
  const noCaps = settings.plan === "api";
  const { primaryLabel, primaryShort, primaryDisplay, primaryTone } = pickChipPrimary(
    noCaps,
    sessionTotal,
    sessionPct,
    weekAllTotal,
    weekAllPct,
    weekSonnetTotal,
    weekSonnetPct
  );

  const setLimitOverride = (key: "session" | "weekAll" | "weekSonnet", v: number) => {
    setSettings((s) => {
      const ov = { ...(s.overrides[s.plan] ?? {}), [key]: v };
      const next = { ...s, overrides: { ...s.overrides, [s.plan]: ov } };
      writeSettings(next);
      return next;
    });
  };

  const setPlan = (p: PlanKey) => {
    setSettings((s) => {
      const next = { ...s, plan: p };
      writeSettings(next);
      return next;
    });
    setShowPlanPicker(false);
  };

  return (
    <div className="relative">
      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.96 }}
        className="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-md text-[10.5px] font-mono font-semibold border cursor-pointer transition-colors font-[inherit]"
        style={{
          background: primaryTone.bg,
          borderColor: primaryTone.border,
          color: primaryTone.fg
        }}
        title={`${primaryLabel}: ${primaryDisplay}`}
      >
        <Icon name="bolt" size={9} />
        <span className="uppercase tracking-[0.4px] text-[9px] font-extrabold opacity-80">
          {primaryShort}
        </span>
        <span>{primaryDisplay}</span>
        {!noCaps && (
          <span className="w-9 h-[5px] rounded-sm bg-s2 overflow-hidden border border-b1">
            <span
              className="block h-full transition-[width]"
              style={{
                width: `${Math.min(100, Math.max(0, primaryTone.barPct))}%`,
                background: primaryTone.fg
              }}
            />
          </span>
        )}
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 360, damping: 28 }}
            className="absolute top-[calc(100%+8px)] right-0 w-[380px] z-[80] rounded-xl bg-glass border border-glass-border backdrop-blur-md overflow-hidden"
            style={{
              boxShadow:
                "0 22px 56px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset"
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-2 border-b border-b1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-t1 tracking-[-0.15px]">
                  Your usage limits
                </span>
                <SourceBadge available={auth.available} />
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-6 h-6 inline-flex items-center justify-center rounded text-t4 hover:text-t1 hover:bg-s2 cursor-pointer border-0 bg-transparent font-[inherit]"
                aria-label="Close"
              >
                <Icon name="x" size={11} />
              </button>
            </div>

            {/* Plan row */}
            <div className="px-3.5 pt-2.5 pb-2 border-b border-b1 relative">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.6px] text-t4">
                  Plan
                </span>
                <button
                  type="button"
                  onClick={() => setShowPlanPicker((p) => !p)}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-s2 hover:bg-s3 border border-b1 hover:border-b2 text-t1 text-[11.5px] font-semibold cursor-pointer transition-colors font-[inherit]"
                >
                  <span>{preset.name}</span>
                  <Icon name="chevronD" size={9} />
                </button>
              </div>
              <div className="text-[10px] text-t4 mt-0.5">{preset.note}</div>
              <AnimatePresence>
                {showPlanPicker && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -2, scale: 0.985 }}
                    transition={{ duration: 0.14 }}
                    className="absolute right-3.5 top-[42px] w-[210px] bg-s1 border border-b2 rounded-lg overflow-hidden z-10"
                    style={{ boxShadow: "0 14px 32px rgba(0,0,0,0.55)" }}
                  >
                    {PLAN_ORDER.map((k) => {
                      const p = PLAN_PRESETS[k];
                      const active = k === settings.plan;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setPlan(k)}
                          className={[
                            "w-full text-left px-3 py-2 cursor-pointer font-[inherit] transition-colors border-0 bg-transparent flex flex-col",
                            active ? "bg-accent-soft" : "hover:bg-s2"
                          ].join(" ")}
                        >
                          <span className="flex items-center justify-between">
                            <span
                              className={`text-[12px] font-semibold ${active ? "text-accent-glow" : "text-t1"}`}
                            >
                              {p.name}
                            </span>
                            {active && <Icon name="check" size={10} />}
                          </span>
                          <span className="text-[10px] text-t4 mt-0.5">{p.note}</span>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="px-3.5 py-3 max-h-[60vh] overflow-y-auto">
              {/* Server-truth rate limits, when present (API mode). These come
                  from Anthropic's `anthropic-ratelimit-*` response headers and
                  are the exact numbers Anthropic uses to enforce quota. */}
              {serverLimit && hasAnyBucket(serverLimit) && (
                <div className="mb-3 pb-3 border-b border-b1">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] font-bold text-t1">
                      Server-reported limits
                    </span>
                    <span
                      className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-[0.5px] text-[var(--ok)] px-1.5 py-[1px] rounded border"
                      style={{
                        background: "var(--ok-soft)",
                        borderColor: "rgba(52,211,153,0.35)"
                      }}
                      title={`Updated ${formatAgo(serverLimitAt, tick)} from anthropic-ratelimit-* response headers`}
                    >
                      <Icon name="check" size={8} />
                      Live
                    </span>
                  </div>
                  {serverLimit.tokens.limit !== undefined && (
                    <ServerLimitBar
                      label="Tokens"
                      bucket={serverLimit.tokens}
                      tick={tick}
                    />
                  )}
                  {serverLimit.requests.limit !== undefined && (
                    <ServerLimitBar
                      label="Requests"
                      bucket={serverLimit.requests}
                      tick={tick}
                    />
                  )}
                  <div className="text-[10px] text-t4 mt-1.5 leading-[1.4]">
                    Direct from Anthropic. Resets automatically; you'll see
                    new numbers after every API call.
                  </div>
                </div>
              )}

              {/* Current session */}
              <UsageRow
                label="Current session"
                pct={sessionPct}
                used={sessionTotal}
                limit={limits.session}
                sub={
                  auth.available && auth.session.resetsAt > 0
                    ? `Resets in ${formatCountdown(auth.session.resetsAt, tick)}`
                    : auth.available
                      ? "No activity in the last 5 hours"
                      : "Estimated · resets per Anthropic's 5-hour window"
                }
                noCap={limits.session === 0}
                onLimitChange={(v) => setLimitOverride("session", v)}
              />

              {/* Weekly limits group */}
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-bold text-t1">Weekly limits</span>
                </div>

                <UsageRow
                  label="All models"
                  pct={weekAllPct}
                  used={weekAllTotal}
                  limit={limits.weekAll}
                  sub={`Resets ${formatWeeklyReset()}`}
                  noCap={limits.weekAll === 0}
                  onLimitChange={(v) => setLimitOverride("weekAll", v)}
                />

                <UsageRow
                  label="Sonnet only"
                  pct={weekSonnetPct}
                  used={weekSonnetTotal}
                  limit={limits.weekSonnet}
                  sub={`Resets ${formatWeeklyReset()}`}
                  tooltip="Counts every assistant message produced by any Claude Sonnet model this week."
                  noCap={limits.weekSonnet === 0}
                  onLimitChange={(v) => setLimitOverride("weekSonnet", v)}
                />
              </div>

              {/* Footer: last updated + refresh */}
              <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-b1">
                <span className="text-[10.5px] text-t4">
                  {auth.generatedAt
                    ? `Last updated: ${formatAgo(auth.generatedAt, tick)}`
                    : "No data yet"}
                </span>
                <button
                  type="button"
                  onClick={() => send({ type: "refreshUsage" })}
                  className="inline-flex items-center gap-1 px-1.5 py-[3px] rounded text-[10.5px] text-t3 hover:text-t1 hover:bg-s2 bg-transparent border border-transparent hover:border-b1 cursor-pointer font-[inherit] transition-colors"
                  aria-label="Refresh usage now"
                  title="Refresh now"
                >
                  <Icon name="refresh" size={10} />
                  Refresh
                </button>
              </div>

              {/* Disclaimer */}
              <div className="text-[10px] text-t4 mt-2 leading-[1.45]">
                Limits are best-guesses of Anthropic's published per-plan caps —
                they may not match your account exactly. Click any limit number
                to set a custom value, or change plan above.
                {auth.available
                  ? " Totals come from Claude Code's session files on this machine; claude.ai browser activity isn't visible to the extension."
                  : " Token counts are client-side estimates until Claude Code session files are present."}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────── Sub-components ───────────────────

function SourceBadge({ available }: { available: boolean }) {
  return available ? (
    <span
      className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-[0.5px] text-[var(--ok)] px-1.5 py-[1px] rounded border"
      style={{
        background: "var(--ok-soft)",
        borderColor: "rgba(52,211,153,0.35)"
      }}
      title="Aggregated from Claude Code session files on this machine"
    >
      <Icon name="check" size={8} />
      Authoritative
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-[0.5px] text-t3 px-1.5 py-[1px] rounded border border-b1 bg-s2"
      title="Client-side estimate (no Claude Code session files for this workspace)"
    >
      Estimate
    </span>
  );
}

function UsageRow({
  label,
  pct,
  used,
  limit,
  sub,
  tooltip,
  noCap,
  onLimitChange
}: {
  label: string;
  pct: number;
  used: number;
  limit: number;
  sub: string;
  tooltip?: string;
  noCap: boolean;
  onLimitChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => {
    if (!editing) setDraft(String(limit));
  }, [limit, editing]);

  const tone = toneFor(pct);
  const overLimit = !noCap && pct >= 100;
  const commit = () => {
    setEditing(false);
    const parsed = parseLimit(draft);
    if (parsed && parsed !== limit) onLimitChange(parsed);
  };

  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12px] font-semibold text-t1">{label}</span>
          {tooltip && (
            <span
              className="w-3 h-3 rounded-full bg-s2 border border-b1 text-t3 inline-flex items-center justify-center text-[8px] font-bold cursor-help"
              title={tooltip}
            >
              ⓘ
            </span>
          )}
        </div>
        {noCap ? (
          <span className="text-[10.5px] font-mono font-semibold text-t3">
            no cap
          </span>
        ) : overLimit ? (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.4px] px-1.5 py-[1px] rounded border"
            style={{
              color: "var(--warn)",
              background: "var(--warn-soft)",
              borderColor: "rgba(251,191,36,0.4)"
            }}
            title="Your usage is above the limit for this plan — pick the right plan above, or click the limit to set a custom value"
          >
            <Icon name="zap" size={8} />
            Above plan default
          </span>
        ) : (
          <span className="text-[11px] font-mono font-semibold text-t2">
            {pct.toFixed(0)}% used
          </span>
        )}
      </div>
      {!noCap && (
        <div className="h-[6px] rounded-sm bg-s2 overflow-hidden border border-b1 mb-1 relative">
          <motion.div
            className="h-full"
            style={{ background: tone.fg }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, pct)}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
          {overLimit && (
            <div
              className="absolute top-0 right-0 h-full"
              style={{
                width: 6,
                background:
                  "repeating-linear-gradient(45deg, var(--warn), var(--warn) 2px, transparent 2px, transparent 4px)"
              }}
              aria-hidden
            />
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-[10.5px] text-t4">
        <span>{sub}</span>
        <span className="font-mono">
          <span className="text-t2">{formatNum(used)}</span>
          {!noCap && (
            <>
              <span className="mx-1 text-t4/70">/</span>
              {editing ? (
                <input
                  type="text"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") {
                      setDraft(String(limit));
                      setEditing(false);
                    }
                  }}
                  className="w-16 bg-s0 border border-accent rounded px-1 py-[1px] text-[10px] font-mono text-t1 outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-t3 hover:text-accent-glow underline-offset-2 hover:underline cursor-pointer bg-transparent border-0 p-0 m-0 font-mono font-[inherit] text-[10.5px]"
                  title="Click to set a custom limit for this plan"
                >
                  {formatCompact(limit)}
                </button>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function ServerLimitBar({
  label,
  bucket,
  tick
}: {
  label: string;
  bucket: { limit?: number; remaining?: number; resetsAt?: number };
  tick: number;
}) {
  const limit = bucket.limit ?? 0;
  const remaining = bucket.remaining ?? limit;
  const used = Math.max(0, limit - remaining);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = toneFor(pct);
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] font-semibold text-t1">{label}</span>
        <span className="text-[10.5px] font-mono text-t2">
          {formatNum(used)}{" "}
          <span className="text-t4/70">/ {formatNum(limit)}</span>
        </span>
      </div>
      <div className="h-[5px] rounded-sm bg-s2 overflow-hidden border border-b1">
        <motion.div
          className="h-full"
          style={{ background: tone.fg }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>
      {bucket.resetsAt && (
        <div className="text-[10px] text-t4 mt-0.5">
          {formatNum(remaining)} remaining · resets in{" "}
          {formatCountdown(bucket.resetsAt, tick)}
        </div>
      )}
    </div>
  );
}

function hasAnyBucket(r: RateLimitInfo): boolean {
  return (
    r.tokens.limit !== undefined ||
    r.inputTokens.limit !== undefined ||
    r.outputTokens.limit !== undefined ||
    r.requests.limit !== undefined
  );
}

// ─────────────────── Helpers ───────────────────

function pctOf(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return (used / limit) * 100;
}

function totalOf(t: UsageTotals): number {
  // Includes cache-created tokens (they cost) but NOT cache-read (cheap).
  return t.inputTokens + t.outputTokens + t.cacheCreatedTokens;
}

function estimateSession(events: ReadonlyArray<TimelineEvent>, streaming: string) {
  let input = 0;
  let output = 0;
  for (const e of events) {
    const body = e.body ?? "";
    const tokens = Math.ceil(body.length / 4);
    if (e.kind === "user" || e.kind === "tool_result") input += tokens;
    else if (e.kind === "assistant" || e.kind === "tool_call") output += tokens;
  }
  output += Math.ceil(streaming.length / 4);
  return { input, output };
}

interface Tone {
  fg: string;
  bg: string;
  border: string;
  /** % to fill the chip bar (clamped 0-100 for display). */
  barPct: number;
}

function toneFor(pct: number, barPct: number = pct): Tone {
  if (pct < 50)
    return { fg: "var(--ok)", bg: "var(--ok-soft)", border: "var(--ok)", barPct };
  if (pct < 80)
    return { fg: "var(--warn)", bg: "var(--warn-soft)", border: "var(--warn)", barPct };
  if (pct < 100)
    return { fg: "var(--err)", bg: "var(--err-soft)", border: "var(--err)", barPct };
  // Over-limit: warm amber, not alarming red, since we may just have the plan wrong.
  return {
    fg: "var(--warn)",
    bg: "var(--warn-soft)",
    border: "var(--warn)",
    barPct: 100
  };
}

function pickChipPrimary(
  noCaps: boolean,
  sessionUsed: number,
  sessionPct: number,
  weekAllUsed: number,
  weekAllPct: number,
  weekSonnetUsed: number,
  weekSonnetPct: number
): {
  primaryLabel: string;
  primaryShort: string;
  primaryDisplay: string;
  primaryTone: Tone;
} {
  if (noCaps) {
    return {
      primaryLabel: "Current session",
      primaryShort: "5H",
      primaryDisplay: formatCompact(sessionUsed),
      primaryTone: {
        fg: "var(--accent-glow)",
        bg: "var(--accent-soft)",
        border: "var(--accent-mid)",
        barPct: 0
      }
    };
  }
  const candidates = [
    { label: "Current session", short: "5H", used: sessionUsed, pct: sessionPct },
    { label: "Weekly (all models)", short: "WK", used: weekAllUsed, pct: weekAllPct },
    {
      label: "Weekly (Sonnet)",
      short: "SON",
      used: weekSonnetUsed,
      pct: weekSonnetPct
    }
  ];
  candidates.sort((a, b) => b.pct - a.pct);
  const top = candidates[0];
  const tone = toneFor(top.pct, Math.min(100, top.pct));
  const display = top.pct >= 100 ? "over" : `${Math.round(top.pct)}%`;
  return {
    primaryLabel: top.label,
    primaryShort: top.short,
    primaryDisplay: display,
    primaryTone: tone
  };
}

function formatCountdown(resetsAt: number, _tick: number): string {
  const diff = resetsAt - Date.now();
  if (diff <= 0) return "now";
  const totalMin = Math.floor(diff / 60_000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr === 0) return `${min} min`;
  if (min === 0) return `${hr} hr`;
  return `${hr} hr ${min} min`;
}

function formatAgo(ts: number, _tick: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  return `${Math.floor(diff / 3_600_000)} hr ago`;
}

function formatWeeklyReset(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const days = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  d.setDate(d.getDate() + days);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} 12:00 AM`;
}

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return v >= 10 ? Math.round(v) + "k" : v.toFixed(1).replace(/\.0$/, "") + "k";
  }
  const v = n / 1_000_000;
  return v >= 10 ? Math.round(v) + "M" : v.toFixed(2).replace(/\.?0+$/, "") + "M";
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function parseLimit(s: string): number | null {
  const trimmed = s.trim().toLowerCase().replace(/[, _]/g, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.round(base * mult);
}
