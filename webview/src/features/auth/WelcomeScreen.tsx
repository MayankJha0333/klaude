// ─────────────────────────────────────────────────────────────
// WelcomeScreen — automated Claude.ai Subscription sign-in.
//
// Click "Sign in with Claude" → host spawns the bundled
// `claude setup-token`, captures its stdout, opens the OAuth URL
// in the user's default browser via vscode.env.openExternal, and
// stores the emitted token in SecretStorage. The UI tracks each
// stage in real time via `setupProgress` events.
//
// If the auto-flow errors out (rare — typically a missing binary or
// a stale OAuth state), a manual paste fallback is one disclosure
// click away.
// ─────────────────────────────────────────────────────────────

import { KeyboardEvent, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Orb, Spinner } from "../../design/primitives";
import { Icon, BrandMark } from "../../design/icons";
import { send, onMessage } from "../../lib/rpc";

type SetupStage =
  | "idle"
  | "launching"
  | "awaitingBrowser"
  | "saving"
  | "done"
  | "error";

type TokenKind = "oauth" | "api" | "unknown" | "empty";

export function WelcomeScreen() {
  const [stage, setStage] = useState<SetupStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // Subscribe to host's setup + manual-paste progress events.
  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "setupProgress") {
        setStage(m.stage);
        if (m.stage === "error") {
          setError(m.error ?? "Sign-in failed.");
        } else {
          setError(null);
        }
      } else if (m.type === "tokenResult") {
        setManualSubmitting(false);
        if (m.ok) {
          setError(null);
          setManualToken("");
        } else {
          setError(m.error ?? "Token rejected.");
        }
      }
    });
  }, []);

  const handleAutoSignIn = () => {
    setError(null);
    setStage("launching");
    send({ type: "startClaudeSetup" });
  };

  const handleCancel = () => {
    send({ type: "cancelClaudeSetup" });
    setStage("idle");
  };

  const handleConfirmSignedIn = () => {
    send({ type: "confirmClaudeSetup" });
  };

  const handleManualSubmit = () => {
    const t = manualToken.trim();
    if (!t || manualSubmitting) return;
    setManualSubmitting(true);
    setError(null);
    send({ type: "submitToken", token: t });
  };

  const onManualKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  const manualKind = classify(manualToken);
  const manualValid = manualKind === "oauth" || manualKind === "api";

  return (
    <motion.div
      className="flex-1 overflow-y-auto px-6 py-8 flex flex-col bg-s0 relative"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Ambient copper glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(211,115,80,0.12), transparent 70%)"
        }}
      />

      {/* Hero */}
      <motion.div
        className="text-center mb-7 flex flex-col items-center relative"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <Orb size={68} />
        <h1 className="text-[24px] font-extrabold tracking-[-0.6px] m-0 mt-3 mb-1.5 text-t1">
          Welcome to Klaude
        </h1>
        <p className="text-[13px] text-t3 m-0 leading-[1.55] max-w-[320px]">
          Agentic coding for VS Code — powered by your Claude subscription.
        </p>
      </motion.div>

      {/* Main card */}
      <motion.div
        className="relative bg-s1 border border-b1 rounded-2xl overflow-hidden"
        style={{
          boxShadow:
            "0 24px 60px -24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset"
        }}
        initial={{ opacity: 0, y: 10, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-b1 bg-s2/40">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center text-on-accent"
            style={{
              background: "var(--brand-tile-gradient)",
              boxShadow: "0 1px 6px var(--accent-shadow)"
            }}
            aria-hidden
          >
            <BrandMark size={15} />
          </div>
          <span className="text-[13px] font-bold tracking-[-0.2px] text-t1">
            Sign in with Claude.ai Subscription
          </span>
          <span className="ml-auto text-[10.5px] font-bold tracking-[0.5px] uppercase text-t4">
            Pro · Team · Enterprise
          </span>
        </div>

        {/* Body */}
        <div className="p-5">
          <AnimatePresence mode="wait" initial={false}>
            {stage === "idle" && (
              <motion.div key="idle" {...fade}>
                <p className="text-[13px] leading-[1.6] m-0 mb-4 text-t2">
                  We'll open a terminal that runs <code className="font-mono text-accent-glow">claude setup-token</code>. Follow the prompts to sign in
                  via your browser, then come back here.
                </p>
                <button
                  type="button"
                  onClick={handleAutoSignIn}
                  className="w-full inline-flex items-center justify-center gap-2 bg-accent text-on-accent border-0 px-3 py-[12px] rounded-lg cursor-pointer text-[13.5px] font-bold tracking-[-0.1px] transition-all duration-150 font-[inherit] hover:bg-accent-deep hover:-translate-y-px"
                  style={{ boxShadow: "0 4px 18px var(--accent-shadow)" }}
                >
                  <Icon name="sparkle" size={13} />
                  Sign in with Claude
                </button>
              </motion.div>
            )}

            {(stage === "launching" ||
              stage === "awaitingBrowser" ||
              stage === "saving") && (
              <motion.div key="progress" {...fade}>
                <ProgressList stage={stage} />
                {stage === "awaitingBrowser" && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-4 bg-s2/50 border border-b1 rounded-lg px-3 py-2.5"
                  >
                    <p className="text-[11.5px] text-t3 m-0 mb-2 leading-[1.5]">
                      Complete the sign-in in the{" "}
                      <span className="text-t1 font-semibold">Klaude Sign-in</span>{" "}
                      terminal at the bottom — open the URL it prints, then
                      paste the code back into the terminal. Click below once
                      it says you're signed in.
                    </p>
                    <button
                      type="button"
                      onClick={handleConfirmSignedIn}
                      className="w-full bg-accent text-on-accent border-0 px-3 py-2 rounded-lg cursor-pointer text-[12.5px] font-bold transition-all duration-150 font-[inherit] hover:bg-accent-deep"
                      style={{ boxShadow: "0 2px 10px var(--accent-shadow)" }}
                    >
                      I've signed in — continue
                    </button>
                  </motion.div>
                )}
                <button
                  type="button"
                  onClick={handleCancel}
                  className="w-full mt-3 bg-transparent text-t3 border border-b2 px-3 py-2 rounded-lg cursor-pointer text-[12.5px] font-semibold transition-colors duration-150 font-[inherit] hover:bg-s2 hover:text-t1"
                >
                  Cancel
                </button>
              </motion.div>
            )}

            {stage === "done" && (
              <motion.div key="done" {...fade}>
                <div className="text-center py-3">
                  <div
                    className="inline-flex items-center justify-center w-10 h-10 rounded-full mb-2"
                    style={{
                      background: "var(--ok-soft)",
                      border: "1px solid rgba(74,222,128,0.45)"
                    }}
                  >
                    <Icon name="check" size={16} />
                  </div>
                  <p className="text-[13.5px] font-bold m-0 text-t1">
                    Signed in
                  </p>
                  <p className="text-[12px] text-t3 m-0 mt-1">
                    Loading your workspace…
                  </p>
                </div>
              </motion.div>
            )}

            {stage === "error" && (
              <motion.div key="error" {...fade}>
                <div
                  className="bg-err-soft text-err border border-[rgba(248,113,113,0.35)] rounded-lg px-3 py-2.5 text-[12px] mb-3 leading-[1.5]"
                >
                  <div className="font-bold mb-1 inline-flex items-center gap-1">
                    <Icon name="x" size={11} />
                    Sign-in failed
                  </div>
                  {error ?? "Unknown error."}
                </div>
                <button
                  type="button"
                  onClick={handleAutoSignIn}
                  className="w-full bg-accent text-on-accent border-0 px-3 py-[11px] rounded-lg cursor-pointer text-[13px] font-bold tracking-[-0.1px] transition-all duration-150 font-[inherit] hover:bg-accent-deep mb-2"
                  style={{ boxShadow: "0 2px 12px var(--accent-shadow)" }}
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => setManualOpen(true)}
                  className="w-full bg-transparent text-t2 border border-b2 px-3 py-2 rounded-lg cursor-pointer text-[12.5px] font-semibold transition-colors duration-150 font-[inherit] hover:bg-s2 hover:text-t1"
                >
                  Paste a token manually
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Manual paste fallback — collapsed by default, revealed on
          demand from the idle screen or auto-revealed from an error. */}
      <AnimatePresence initial={false}>
        {(manualOpen || stage === "error") && (
          <motion.div
            key="manual"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="mt-4 bg-s1 border border-b1 rounded-2xl p-5">
              <div className="text-[12.5px] font-semibold text-t1 mb-2 flex items-center gap-1.5">
                <Icon name="code" size={12} />
                Paste a token manually
              </div>
              <p className="text-[11.5px] leading-[1.55] m-0 mb-2.5 text-t3">
                Use an OAuth token from{" "}
                <code className="font-mono text-accent-glow">claude setup-token</code>{" "}
                or an Anthropic Console API key (
                <code className="font-mono text-accent-glow">sk-ant-api…</code>).
              </p>
              <input
                type="password"
                spellCheck={false}
                placeholder="sk-ant-oat… or sk-ant-api…"
                value={manualToken}
                onChange={(e) => {
                  setManualToken(e.target.value.replace(/\s+/g, ""));
                  if (error) setError(null);
                }}
                onKeyDown={onManualKey}
                disabled={manualSubmitting}
                className="w-full bg-s0 text-t1 border border-b2 rounded-lg px-3 py-2.5 font-mono text-[12px] focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] transition-[border-color,box-shadow] duration-150"
              />
              {manualToken && (
                <div
                  className={`text-[11px] font-semibold mt-1.5 inline-flex items-center gap-1 ${
                    manualValid ? "text-[var(--ok)]" : "text-[var(--warn)]"
                  }`}
                >
                  <Icon name={manualValid ? "check" : "shield"} size={10} />
                  {manualKind === "oauth" && "OAuth subscription token detected"}
                  {manualKind === "api" && "Anthropic Console API key detected"}
                  {manualKind === "unknown" &&
                    "Unrecognized format — should start with sk-ant-…"}
                </div>
              )}
              <button
                type="button"
                onClick={handleManualSubmit}
                disabled={!manualValid || manualSubmitting}
                className="w-full mt-3 bg-accent text-on-accent border-0 px-3 py-[10px] rounded-lg cursor-pointer text-[12.5px] font-bold transition-all duration-150 font-[inherit] hover:not-[:disabled]:bg-accent-deep disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {manualSubmitting ? "Signing in…" : "Sign in with token"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Disclosure button for manual paste — only on idle screen */}
      {stage === "idle" && !manualOpen && (
        <motion.button
          type="button"
          onClick={() => setManualOpen(true)}
          className="text-[11.5px] text-t3 hover:text-t1 transition-colors mt-3 bg-transparent border-0 cursor-pointer font-[inherit] mx-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.2 }}
        >
          Already have a token? Paste it manually →
        </motion.button>
      )}

      {/* Footnote */}
      <motion.div
        className="text-center text-[11px] text-t4 mt-auto pt-8 leading-[1.55] relative"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.3 }}
      >
        Token is stored in VS Code's SecretStorage (OS keychain).
        <br />
        Klaude never writes to{" "}
        <code className="font-mono text-t3">~/.claude/</code>.
      </motion.div>
    </motion.div>
  );
}

// ─────────────────── Progress list ───────────────────

function ProgressList({ stage }: { stage: SetupStage }) {
  const items: Array<{
    key: SetupStage;
    title: string;
    sub: string;
  }> = [
    {
      key: "launching",
      title: "Opening terminal",
      sub: "Starting `claude setup-token` in a new terminal…"
    },
    {
      key: "awaitingBrowser",
      title: "Sign in via terminal",
      sub: "Follow the prompts in the terminal at the bottom."
    },
    {
      key: "saving",
      title: "Finishing up",
      sub: "Activating your Claude credentials…"
    }
  ];

  const stageIndex = items.findIndex((it) => it.key === stage);

  return (
    <div className="flex flex-col gap-3">
      {items.map((it, i) => {
        const state: "pending" | "active" | "done" =
          i < stageIndex ? "done" : i === stageIndex ? "active" : "pending";
        return <ProgressRow key={it.key} state={state} title={it.title} sub={it.sub} />;
      })}
    </div>
  );
}

function ProgressRow({
  state,
  title,
  sub
}: {
  state: "pending" | "active" | "done";
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
        {state === "done" && (
          <motion.span
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 360, damping: 22 }}
            className="w-6 h-6 rounded-full inline-flex items-center justify-center bg-[var(--ok-soft)] border border-[rgba(74,222,128,0.4)] text-[var(--ok)]"
          >
            <Icon name="check" size={11} />
          </motion.span>
        )}
        {state === "active" && <Spinner size={16} />}
        {state === "pending" && (
          <span className="w-2 h-2 rounded-full bg-b2" aria-hidden />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[12.5px] font-semibold ${
            state === "pending" ? "text-t3" : "text-t1"
          }`}
        >
          {title}
        </div>
        <div className="text-[11px] text-t3 mt-0.5">{sub}</div>
      </div>
    </div>
  );
}

// ─────────────────── Helpers ───────────────────

function classify(token: string): TokenKind {
  const t = token.trim();
  if (!t) return "empty";
  if (t.startsWith("sk-ant-oat")) return "oauth";
  if (t.startsWith("sk-ant-api")) return "api";
  return "unknown";
}

const fade = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18 }
} as const;
