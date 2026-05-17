// ─────────────────────────────────────────────────────────────
// WelcomeScreen — single-path Claude.ai Subscription sign-in.
//
// Layout is intentionally tall and step-numbered so the user
// always knows what to do next:
//
//   ① Run `claude setup-token` to get a token
//      → Click button → terminal opens → browser OAuth → token
//        printed in terminal
//
//   ② Paste the token here
//      → Hidden input, live format detection
//
//   ③ Sign in
//      → Token goes to SecretStorage via `submitToken` RPC
//
// Token is injected as `ANTHROPIC_API_KEY` whenever Iridescent
// spawns the bundled `claude` CLI. No `~/.claude/` mutation.
// ─────────────────────────────────────────────────────────────

import { KeyboardEvent, ReactNode, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Orb } from "../../design/primitives";
import { Icon } from "../../design/icons";
import { send, onMessage } from "../../lib/rpc";

type TokenKind = "oauth" | "api" | "unknown" | "empty";

export function WelcomeScreen() {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchedTerminal, setLaunchedTerminal] = useState(false);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type !== "tokenResult") return;
      setSubmitting(false);
      if (m.ok) {
        setError(null);
        setToken("");
      } else {
        setError(m.error ?? "Token rejected.");
      }
    });
  }, []);

  const kind = classify(token);
  const valid = kind === "oauth" || kind === "api";

  const submit = () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    send({ type: "submitToken", token: token.trim() });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  const launchOAuth = () => {
    send({ type: "runTerminalCommand", command: "claude setup-token" });
    setLaunchedTerminal(true);
  };

  return (
    <motion.div
      className="flex-1 overflow-y-auto px-6 py-8 flex flex-col bg-s0 relative"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Ambient gradient — pure CSS, near-zero cost. Adds depth so the
          form doesn't feel like a flat dialog. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(99,102,241,0.12), transparent 70%)"
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
          Welcome to Iridescent
        </h1>
        <p className="text-[13px] text-t3 m-0 leading-[1.55] max-w-[320px]">
          Agentic coding for VS Code — powered by your Claude subscription.
        </p>
      </motion.div>

      {/* Step card */}
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
        {/* Card header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-b1 bg-s2/40">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center text-white"
            style={{
              background:
                "conic-gradient(from 180deg, var(--accent), var(--accent-glow), var(--accent))",
              boxShadow: "0 1px 6px var(--accent-shadow)"
            }}
            aria-hidden
          >
            <Icon name="sparkle" size={11} />
          </div>
          <span className="text-[13px] font-bold tracking-[-0.2px] text-t1">
            Sign in with Claude.ai Subscription
          </span>
          <span className="ml-auto text-[10.5px] font-bold tracking-[0.5px] uppercase text-t4">
            Pro · Team · Enterprise
          </span>
        </div>

        {/* Steps */}
        <div className="p-5 flex flex-col gap-5">
          <Step
            n={1}
            title="Get your token"
            done={launchedTerminal}
          >
            <p className="text-[12.5px] leading-[1.55] m-0 mb-2.5 text-t3">
              We'll run{" "}
              <code className="font-mono bg-s2 border border-b1 px-1.5 py-px rounded-[4px] text-[11.5px] text-accent-glow">
                claude setup-token
              </code>{" "}
              in a terminal. It opens claude.ai in your browser, walks you
              through signing in, and prints a long-lived OAuth token.
            </p>
            <button
              type="button"
              onClick={launchOAuth}
              className={[
                "w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md cursor-pointer text-[12.5px] font-semibold font-[inherit] transition-colors duration-150 border",
                launchedTerminal
                  ? "bg-s2 border-b2 text-t2 hover:bg-s3"
                  : "bg-accent-soft border-accent-mid text-accent-glow hover:bg-accent-mid hover:text-t1"
              ].join(" ")}
            >
              <Icon name="terminal" size={12} />
              {launchedTerminal ? "Reopen terminal" : "Run claude setup-token"}
            </button>
          </Step>

          <Divider />

          <Step
            n={2}
            title="Paste the token"
            done={valid}
          >
            <input
              type="password"
              spellCheck={false}
              placeholder="sk-ant-oat…"
              value={token}
              onChange={(e) => {
                setToken(e.target.value.replace(/\s+/g, ""));
                if (error) setError(null);
              }}
              onKeyDown={onKey}
              disabled={submitting}
              className="w-full bg-s0 text-t1 border border-b2 rounded-lg px-3 py-2.5 font-mono text-[12px] focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] transition-[border-color,box-shadow] duration-150"
            />
            <AnimatePresence mode="wait">
              {token && (
                <motion.div
                  key={kind}
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2 }}
                  transition={{ duration: 0.14 }}
                  className={`text-[11px] font-semibold mt-2 inline-flex items-center gap-1 ${
                    valid ? "text-[var(--ok)]" : "text-[var(--warn)]"
                  }`}
                >
                  <Icon name={valid ? "check" : "shield"} size={10} />
                  {kind === "oauth" && "OAuth subscription token detected"}
                  {kind === "api" &&
                    "Anthropic Console API key detected — also accepted"}
                  {kind === "unknown" &&
                    "Unrecognized — token should start with sk-ant-oat…"}
                </motion.div>
              )}
            </AnimatePresence>
          </Step>

          <Divider />

          <Step n={3} title="Sign in">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-err-soft text-err border border-[rgba(248,113,113,0.35)] rounded-lg px-3 py-2 text-[11.5px] mb-2.5 leading-[1.45]"
              >
                {error}
              </motion.div>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!valid || submitting}
              className="w-full bg-accent text-white border-0 px-3 py-[11px] rounded-lg cursor-pointer text-[13px] font-bold tracking-[-0.1px] transition-all duration-150 font-[inherit] hover:not-[:disabled]:bg-accent-deep hover:not-[:disabled]:-translate-y-px disabled:opacity-45 disabled:cursor-not-allowed"
              style={{ boxShadow: "0 4px 18px var(--accent-shadow)" }}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </Step>
        </div>
      </motion.div>

      {/* Footnote */}
      <motion.div
        className="text-center text-[11px] text-t4 mt-auto pt-8 leading-[1.55] relative"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.3 }}
      >
        Token is stored in VS Code's SecretStorage (OS keychain).
        <br />
        Iridescent never writes to{" "}
        <code className="font-mono text-t3">~/.claude/</code>.
      </motion.div>
    </motion.div>
  );
}

// ─────────────────── Sub-components ───────────────────

function Step({
  n,
  title,
  children,
  done
}: {
  n: number;
  title: string;
  children: ReactNode;
  done?: boolean;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <div
        className={[
          "flex-shrink-0 w-6 h-6 rounded-full inline-flex items-center justify-center text-[11px] font-extrabold font-mono border transition-colors duration-200",
          done
            ? "bg-[var(--ok-soft)] border-[rgba(74,222,128,0.45)] text-[var(--ok)]"
            : "bg-s2 border-b2 text-t2"
        ].join(" ")}
        aria-hidden
      >
        {done ? <Icon name="check" size={11} /> : n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold text-t1 mb-1.5 tracking-[-0.1px]">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-b1 ml-[34px]" />;
}

function classify(token: string): TokenKind {
  const t = token.trim();
  if (!t) return "empty";
  if (t.startsWith("sk-ant-oat")) return "oauth";
  if (t.startsWith("sk-ant-api")) return "api";
  return "unknown";
}
