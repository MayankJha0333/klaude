import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { ChatProvider, ProviderRequest } from "./base.js";
import { ContentBlock, Message, PermissionMode, StreamDelta, TaskType } from "../core/types.js";
import { getModePrompt, getTaskTypePrompt } from "../services/prompt-loader.js";
import { ConventionsFile } from "../services/conventions.js";

const HARD_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeCliOpts {
  binary: string;
  cwd: string;
  permissionMode?: PermissionMode;
  allowedBashPatterns?: string[];
  /** Skill ids the user toggled OFF in the picker. Enforced via
   *  --disallowedTools "Skill(<id>)" plus a system-prompt append. */
  disabledSkills?: string[];
  /** Heuristic task classification — drives task-type playbook injection
   *  in plan mode only. */
  taskType?: TaskType;
  /** Project conventions file (CLAUDE.md / AGENTS.md / etc.). Injected via
   *  --append-system-prompt unless `alreadyLoadedByCli` is true. */
  conventions?: ConventionsFile | null;
  getResumeSessionId?: () => string | undefined;
  setResumeSessionId?: (id: string) => void;
}

export class ClaudeCliProvider implements ChatProvider {
  readonly id = "claude-cli";
  private child: ChildProcess | null = null;

  constructor(private opts: ClaudeCliOpts) {}

  cancel() {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 2000);
    }
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamDelta> {
    const userText = lastUserText(req.messages);
    if (!userText) {
      yield { type: "error", error: "No user message to send." };
      return;
    }

    const args = buildArgs(userText, req.model, this.opts);

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;

    const timeout = setTimeout(() => child.kill("SIGKILL"), HARD_TIMEOUT_MS);
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let stderrBuf = "";
    child.stderr!.on("data", (b: Buffer) => (stderrBuf += b.toString("utf8")));

    const queue: StreamDelta[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    const push = (d: StreamDelta) => {
      queue.push(d);
      resolver?.();
      resolver = null;
    };

    const processor = makeProcessor(this.opts.setResumeSessionId);

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CliEvent | null = null;
      try {
        ev = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      for (const d of processor(ev)) push(d);
    });

    const onExit = () => {
      clearTimeout(timeout);
      if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
        const msg = stderrBuf.trim() || `claude exited with code ${child.exitCode ?? "?"}`;
        push({ type: "error", error: msg });
      }
      push({ type: "done" });
      done = true;
      resolver?.();
      resolver = null;
    };
    child.once("exit", onExit);
    child.once("error", (err) => {
      push({ type: "error", error: err.message });
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          yield d;
          if (d.type === "done") return;
        }
        if (done) return;
        await new Promise<void>((res) => {
          resolver = res;
        });
      }
    } finally {
      this.child = null;
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}

export function buildArgs(
  userText: string,
  model: string | undefined,
  opts: ClaudeCliOpts
): string[] {
  const args = [
    "-p",
    userText,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose"
  ];
  if (model) args.push("--model", model);

  const cliMode = mapPermissionMode(opts.permissionMode ?? "default");
  args.push("--permission-mode", cliMode);

  if (opts.permissionMode === "auto" && opts.allowedBashPatterns?.length) {
    const tools = [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      ...opts.allowedBashPatterns.map((p) => `Bash(${regexToCliPattern(p)})`)
    ];
    args.push("--allowedTools", ...tools);
  }

  // Skills the user has toggled off in the picker need to be *actually*
  // blocked. Belt-and-suspenders:
  //   1. --disallowedTools "Skill(<name>)" — if Claude Code's permission
  //      system honors per-skill patterns, this is hard enforcement.
  //   2. --append-system-prompt — even if the flag pattern is ignored, the
  //      agent reads the appended instruction and refuses. Together they
  //      cover both the gate path and the model-decides path.
  const disabled = (opts.disabledSkills ?? []).filter((s) => s.length > 0);
  if (disabled.length > 0) {
    args.push(
      "--disallowedTools",
      ...disabled.map((id) => `Skill(${id})`)
    );
    const list = disabled.map((id) => `\`${id}\``).join(", ");
    args.push(
      "--append-system-prompt",
      `The user has disabled the following Claude Code skills via Iridescent's Skills picker: ${list}. Do not invoke any of them, even if a task would benefit. If you would normally use a disabled skill, tell the user which skill is disabled and ask them to re-enable it from the Skills picker before retrying. All other skills remain available.`
    );
  }

  // Per-mode prompt: bundled MD that tunes the model's stance for plan/default/auto.
  const mode = opts.permissionMode ?? "default";
  const modeAppend = getModePrompt(mode);
  if (modeAppend) args.push("--append-system-prompt", modeAppend);

  // Plan-mode only: the matching task-type playbook (backend / frontend / etc.).
  // Skipped for default/auto to keep their token budgets lean.
  if (mode === "plan" && opts.taskType) {
    const taskAppend = getTaskTypePrompt(opts.taskType);
    if (taskAppend) args.push("--append-system-prompt", taskAppend);
  }

  // Project conventions. CLAUDE.md at root is auto-loaded by the CLI itself —
  // re-injecting would double the token cost — so skip in that case.
  if (opts.conventions && !opts.conventions.alreadyLoadedByCli) {
    args.push(
      "--append-system-prompt",
      `Project conventions from \`${opts.conventions.workspaceRelativePath}\`:\n\n${opts.conventions.content}`
    );
  }

  const resumeId = opts.getResumeSessionId?.();
  if (resumeId) args.push("--resume", resumeId);

  return args;
}

function mapPermissionMode(m: PermissionMode): string {
  switch (m) {
    case "plan":
      return "plan";
    case "auto":
      return "acceptEdits";
    default:
      return "default";
  }
}

function regexToCliPattern(p: string): string {
  return p
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\s\+?/g, " ")
    .replace(/\\\./g, ".")
    .replace(/\.\*/g, "*")
    .replace(/\([^)]+\)/g, (m) => m)
    .trim();
}

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
    >;
    usage?: CliUsage;
  };
  event?: {
    type: string;
    content_block?: {
      type: string;
      id?: string;
      name?: string;
      text?: string;
    };
    delta?: {
      type: string;
      text?: string;
      partial_json?: string;
      /** Some CLI versions attach final usage on the message_delta event. */
      usage?: CliUsage;
    };
    index?: number;
  };
  /** End-of-turn result event — has the canonical post-turn usage + cost. */
  usage?: CliUsage;
  total_cost_usd?: number;
  error?: string;
  result?: string;
}

type Processor = (ev: CliEvent) => StreamDelta[];

export function makeProcessor(setResume?: (id: string) => void): Processor {
  let sawPartialText = false;
  const startedToolIds = new Set<string>();
  let currentBlockType: "text" | "tool_use" | "other" | null = null;
  let currentToolId: string | null = null;

  return (ev) => {
    const out: StreamDelta[] = [];

    if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) setResume?.(ev.session_id);
      return out;
    }

    if (ev.type === "stream_event" && ev.event) {
      const inner = ev.event;
      if (inner.type === "content_block_start" && inner.content_block) {
        if (inner.content_block.type === "text") {
          currentBlockType = "text";
        } else if (inner.content_block.type === "tool_use") {
          currentBlockType = "tool_use";
          const id = inner.content_block.id ?? "";
          const name = inner.content_block.name ?? "tool";
          currentToolId = id;
          if (id) startedToolIds.add(id);
          out.push({ type: "tool_use_start", tool: { id, name } });
        } else {
          currentBlockType = "other";
        }
        return out;
      }
      if (inner.type === "content_block_delta" && inner.delta) {
        if (
          currentBlockType === "text" &&
          inner.delta.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          sawPartialText = true;
          out.push({ type: "text", text: inner.delta.text });
        } else if (
          currentBlockType === "tool_use" &&
          inner.delta.type === "input_json_delta" &&
          typeof inner.delta.partial_json === "string"
        ) {
          out.push({ type: "tool_use_input", partialInput: inner.delta.partial_json });
        }
        return out;
      }
      if (inner.type === "content_block_stop") {
        if (currentBlockType === "tool_use") {
          out.push({ type: "tool_use_end" });
          currentToolId = null;
        }
        currentBlockType = null;
        return out;
      }
      return out;
    }

    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text") {
          if (!sawPartialText) out.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          if (!startedToolIds.has(block.id)) {
            startedToolIds.add(block.id);
            out.push({
              type: "tool_use_start",
              tool: { id: block.id, name: block.name }
            });
            out.push({
              type: "tool_use_input",
              partialInput: JSON.stringify(block.input ?? {})
            });
            out.push({ type: "tool_use_end" });
          }
        }
      }
      sawPartialText = false;
      // Some CLI versions ship per-assistant-message usage. Forward it so the
      // meter shows live counts as the turn streams (the final result event
      // sends a corrected total later).
      const u = ev.message.usage;
      if (u) out.push(makeUsageDelta(u, ev.session_id));
      return out;
    }

    if (ev.type === "user" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
              ? block.content
                  .map((c: unknown) => {
                    const cc = c as { type?: string; text?: string };
                    return cc.type === "text" && cc.text ? cc.text : "";
                  })
                  .join("\n")
              : JSON.stringify(block.content);
          out.push({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            resultContent: content,
            resultIsError: !!block.is_error
          });
        }
      }
      return out;
    }

    if (ev.type === "result") {
      // The end-of-turn `result` event carries the canonical totals — emit a
      // usage delta with cost if reported so the meter can switch from
      // estimate to authoritative.
      if (ev.usage) {
        const u = makeUsageDelta(ev.usage, ev.session_id);
        if (u.usage && typeof ev.total_cost_usd === "number") {
          u.usage.costUsd = ev.total_cost_usd;
        }
        out.push(u);
      }
      if (ev.subtype === "error" || ev.subtype === "error_max_turns") {
        out.push({
          type: "error",
          error:
            ev.result ||
            (ev.subtype === "error_max_turns"
              ? "Claude CLI hit max turns. Try a simpler prompt or increase turns."
              : ev.subtype)
        });
      }
      return out;
    }

    if (ev.type === "error") {
      out.push({ type: "error", error: ev.error || "Claude CLI reported an error." });
    }

    return out;
  };
}

export function mapEvent(
  ev: CliEvent,
  setResume?: (id: string) => void
): StreamDelta[] {
  return makeProcessor(setResume)(ev);
}

function makeUsageDelta(u: CliUsage, sessionId?: string): StreamDelta {
  return {
    type: "usage",
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens:
        u.cache_read_input_tokens !== undefined
          ? u.cache_read_input_tokens
          : undefined,
      cacheCreatedTokens:
        u.cache_creation_input_tokens !== undefined
          ? u.cache_creation_input_tokens
          : undefined,
      sessionId
    }
  };
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = (m.content as ContentBlock[])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
