// ─────────────────────────────────────────────────────────────
// App shell — owns auth state, timeline, and shared composer
// inputs (models, skills, pending-insert payload). Code from
// Cmd+L flows in as a structured payload that the RichEditor
// renders as an atomic, editable code block inline.
// ─────────────────────────────────────────────────────────────

import { useEffect, useReducer, useState } from "react";
import {
  send,
  onMessage,
  saveState,
  loadState,
  AuthMode,
  PermissionMode,
  TimelineEvent,
  EditorContext,
  ModelInfo,
  SkillInfo,
  ConventionsSource
} from "./lib/rpc";
import { Spinner, type CodeInsert } from "./design/primitives";
import { AuthGate } from "./features/auth/AuthGate";
import { ChatScreen } from "./features/chat";
import { FALLBACK_MODELS } from "./features/chat/constants";

// ── Auth state ───────────────────────────────────────────────

type AuthState =
  | { status: "loading" }
  | { status: "unauthed"; mode: AuthMode | null; error: string | null; validating: boolean }
  | { status: "authed"; mode: AuthMode; model: string; permissionMode: PermissionMode };

interface Persisted {
  events?: TimelineEvent[];
  input?: string;
  pins?: { path: string; label: string }[];
}

// ── Timeline reducer ─────────────────────────────────────────

type TimelineAction =
  | { type: "reset" }
  | { type: "append"; event: TimelineEvent }
  | { type: "replace"; events: TimelineEvent[] };

function timelineReducer(state: TimelineEvent[], action: TimelineAction): TimelineEvent[] {
  switch (action.type) {
    case "reset":
      return [];
    case "append": {
      const idx = state.findIndex((e) => e.id === action.event.id);
      if (idx === -1) return [...state, action.event];
      // Replace in place when the host re-posts an existing event (e.g. a
      // plan-comment edit mutates meta and re-emits the same id).
      const next = state.slice();
      next[idx] = action.event;
      return next;
    }
    case "replace":
      return action.events;
  }
}

// ── Component ────────────────────────────────────────────────

export function App() {
  const initial = loadState<Persisted>() ?? {};

  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, dispatchTimeline] = useReducer(timelineReducer, initial.events ?? []);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState(initial.input ?? "");
  const [error, setError] = useState<string | null>(null);
  const [editorContext, setEditorContext] = useState<EditorContext | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([...FALLBACK_MODELS]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [pendingInsert, setPendingInsert] = useState<CodeInsert | null>(null);
  const [conventions, setConventions] = useState<{
    source: ConventionsSource | null;
    path: string | null;
    relativePath: string | null;
  }>({ source: null, path: null, relativePath: null });
  const [bannerVisible, setBannerVisible] = useState(false);
  const [skillSuggestion, setSkillSuggestion] = useState<{
    skillId: string;
    skillName: string;
    reason: string;
    taskType: string;
  } | null>(null);
  const [pins, setPins] = useState<{ path: string; label: string }[]>(
    initial.pins ?? []
  );

  // Persist non-volatile UI state.
  useEffect(() => {
    saveState<Persisted>({ events, input, pins });
  }, [events, input, pins]);

  // Single inbound message handler.
  useEffect(() => {
    const off = onMessage((m) => {
      switch (m.type) {
        case "auth": {
          if (m.authed && m.mode && m.model) {
            setAuth({
              status: "authed",
              mode: m.mode,
              model: m.model,
              permissionMode: m.permissionMode ?? "default"
            });
            send({ type: "requestModels" });
            send({ type: "requestSkills" });
          } else {
            setAuth({
              status: "unauthed",
              mode: m.mode ?? null,
              error: null,
              validating: false
            });
          }
          break;
        }
        case "authValidating":
          setAuth((a) =>
            a.status === "unauthed" ? { ...a, validating: true, error: null } : a
          );
          break;
        case "authResult":
          setAuth((a) =>
            a.status === "unauthed"
              ? { ...a, validating: false, error: m.ok ? null : m.error ?? "Failed." }
              : a
          );
          break;
        case "hello":
          setStreaming("");
          setError(null);
          break;
        case "reset":
          dispatchTimeline({ type: "reset" });
          setStreaming("");
          setError(null);
          break;
        case "timeline":
          dispatchTimeline({ type: "append", event: m.event });
          // The orchestrator flushes streamed text into a real assistant
          // event right before any tool_use_start, so when we see either an
          // assistant *or* a tool_call land in the timeline we can safely
          // drop the live streaming buffer — the content it held is now
          // anchored above whatever comes next.
          if (m.event.kind === "assistant" || m.event.kind === "tool_call") {
            setStreaming("");
          }
          break;
        case "delta": {
          const d = m.delta;
          if (d.type === "text") setStreaming((s) => s + d.text);
          else if (d.type === "error") setError(d.error);
          break;
        }
        case "turnStart":
          setBusy(true);
          setStreaming("");
          setError(null);
          break;
        case "turnEnd":
          setBusy(false);
          setStreaming("");
          break;
        case "error":
          setError(m.message);
          setBusy(false);
          break;
        case "editorContext":
          setEditorContext(m.context ?? null);
          break;
        case "rewind":
          dispatchTimeline({ type: "replace", events: m.events });
          setStreaming("");
          setError(null);
          break;
        case "models":
          if (m.models.length) setModels(m.models);
          break;
        case "skills":
          setSkills(m.skills);
          break;
        case "insertSelection":
          // Cmd+L payload — RichEditor renders this as a styled code block
          // at the cursor; the markdown markers never appear to the user.
          setPendingInsert({
            file: m.file,
            language: m.language,
            startLine: m.startLine,
            endLine: m.endLine,
            text: m.text
          });
          setComposerFocusKey((k) => k + 1);
          break;
        case "fileSearchResults":
          // Consumed by MentionPopover via its own subscription.
          break;
        case "historyList":
          // Consumed by HistoryDrawer via its own subscription.
          break;
        case "loadedSession":
          dispatchTimeline({ type: "replace", events: m.events });
          setStreaming("");
          setError(null);
          setBusy(false);
          break;
        case "conventionsStatus":
          setConventions({
            source: m.source,
            path: m.path,
            relativePath: m.relativePath
          });
          break;
        case "conventionsBanner":
          setBannerVisible(true);
          break;
        case "skillSuggestion":
          setSkillSuggestion({
            skillId: m.skillId,
            skillName: m.skillName,
            reason: m.reason,
            taskType: m.taskType
          });
          break;
      }
    });
    send({ type: "refreshAuth" });
    send({ type: "refreshEditorContext" });
    return off;
  }, []);

  if (auth.status === "loading") {
    return (
      <div className="flex flex-col h-screen relative bg-s0">
        <div className="flex items-center justify-center h-full">
          <Spinner size={48} />
        </div>
      </div>
    );
  }

  if (auth.status === "unauthed") {
    return (
      <div className="flex flex-col h-screen relative bg-s0">
        <AuthGate validating={auth.validating} error={auth.error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen relative bg-s0">
      <ChatScreen
        authMode={auth.mode}
        model={auth.model}
        permissionMode={auth.permissionMode}
        events={events}
        streaming={streaming}
        busy={busy}
        input={input}
        error={error}
        editorContext={editorContext}
        models={models}
        skills={skills}
        composerFocusKey={composerFocusKey}
        pendingInsert={pendingInsert}
        conventions={conventions}
        bannerVisible={bannerVisible}
        onHideBanner={() => setBannerVisible(false)}
        skillSuggestion={skillSuggestion}
        onDismissSkillSuggestion={() => setSkillSuggestion(null)}
        onInserted={() => setPendingInsert(null)}
        pins={pins}
        onPin={(p) =>
          setPins((curr) =>
            curr.some((x) => x.path === p.path) ? curr : [...curr, p]
          )
        }
        onUnpin={(path) => setPins((curr) => curr.filter((p) => p.path !== path))}
        onClearPins={() => setPins([])}
        onInput={setInput}
        onSubmit={(text) => {
          // Auto-prepend pinned-file mentions so the agent reliably has
          // them in scope. We use the @-mention syntax the agent already
          // resolves, separated by spaces, then a blank line before the
          // user's text. Skip pins that the user has already mentioned.
          const lowered = text.toLowerCase();
          const auto = pins
            .filter((p) => !lowered.includes(`@${p.label.toLowerCase()}`))
            .map((p) => `@${p.label}`)
            .join(" ");
          const finalText = auto ? `${auto}\n\n${text}` : text;
          send({ type: "prompt", text: finalText });
          setInput("");
        }}
        onCancel={() => send({ type: "cancel" })}
        onDismissError={() => setError(null)}
      />
    </div>
  );
}
