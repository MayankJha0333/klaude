// ─────────────────────────────────────────────────────────────
// Provider factory — subscription-only.
//
// Klaude runs exclusively on the Claude Code subscription via
// the bundled `claude` CLI; the previous API-key fork (direct calls
// to the Anthropic Messages API + in-process tool execution) is
// gone. This file is kept as the single entry point for any future
// provider work so call sites don't need to know about transport
// details.
// ─────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { ChatProvider } from "./base.js";
import { ClaudeCliProvider, EffortLevel } from "./claude-cli.js";
import { PermissionMode, TaskType } from "../core/types.js";
import { ConventionsFile } from "../services/conventions.js";

export interface ProviderContext {
  cwd: string;
  permissionMode?: PermissionMode;
  allowedBashPatterns?: string[];
  /** Skill ids the user has toggled OFF in the picker. Enforced via
   *  --disallowedTools + --append-system-prompt. */
  disabledSkills?: string[];
  /** Heuristic task classification for the current turn — drives task-type
   *  playbook injection in plan mode. */
  taskType?: TaskType;
  /** Project conventions file (CLAUDE.md / AGENTS.md / etc.) for the current
   *  workspace — auto-discovered, injected into the system prompt. */
  conventions?: ConventionsFile | null;
  getResumeSessionId?: () => string | undefined;
  setResumeSessionId?: (id: string) => void;
  /** Auth token (OAuth or API key) injected into the CLI's environment. */
  token?: string;
  /** Optional path to a temp JSON file in CLI's `--mcp-config` format. */
  mcpConfigPath?: string;
  /** Names of the MCP servers in mcpConfigPath — used for auto-mode allowlist. */
  mcpServerNames?: string[];
  /** Reasoning effort for the session (`--effort`). */
  effort?: EffortLevel;
  /** Extended-thinking toggle (`alwaysThinkingEnabled` via `--settings`). */
  thinking?: boolean;
}

// The Claude CLI ships inside the extension via the
// `@anthropic-ai/claude-code` npm dep. Its postinstall copies the
// platform-native binary to bin/claude.exe — same filename on every OS.
// Resolved relative to the compiled extension entry (dist/extension.js)
// so it works both in dev (F5) and inside a packaged .vsix.
//
// Exported so callers outside the chat-stream provider (e.g. the panel's
// `claude logout` silent spawn) can reuse the same resolution.
export function bundledClaudeBinary(): string {
  return path.resolve(
    __dirname,
    "..",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe"
  );
}

/**
 * The `claude` binary Klaude should run. Defaults to the bundled CLI, but if
 * `klaude.claudeBinaryPath` points at an existing file we use that instead.
 *
 * This is the "dynamic models" escape hatch: model aliases (`opus`,
 * `default`, …) resolve to whatever the *binary* knows, so the set of
 * available models tracks the binary's version. Pointing this at a
 * self-updating native `claude` install (`which claude`) means new models
 * (e.g. a future Opus bump) show up automatically as that CLI updates —
 * no need to wait for a new Klaude release. The bundled CLI remains the
 * default and the fallback when the configured path is missing.
 */
export function resolveClaudeBinary(): string {
  const override = vscode.workspace
    .getConfiguration("klaude")
    .get<string>("claudeBinaryPath", "")
    .trim();
  if (override && fs.existsSync(override)) return override;
  return bundledClaudeBinary();
}

export function createProvider(ctx: ProviderContext): ChatProvider {
  return new ClaudeCliProvider({
    binary: resolveClaudeBinary(),
    cwd: ctx.cwd,
    permissionMode: ctx.permissionMode,
    allowedBashPatterns: ctx.allowedBashPatterns,
    disabledSkills: ctx.disabledSkills,
    taskType: ctx.taskType,
    conventions: ctx.conventions,
    getResumeSessionId: ctx.getResumeSessionId,
    setResumeSessionId: ctx.setResumeSessionId,
    token: ctx.token,
    mcpConfigPath: ctx.mcpConfigPath,
    mcpServerNames: ctx.mcpServerNames,
    effort: ctx.effort,
    thinking: ctx.thinking
  });
}
