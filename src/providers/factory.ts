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
import { ChatProvider } from "./base.js";
import { ClaudeCliProvider } from "./claude-cli.js";
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

export function createProvider(ctx: ProviderContext): ChatProvider {
  return new ClaudeCliProvider({
    binary: bundledClaudeBinary(),
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
    mcpServerNames: ctx.mcpServerNames
  });
}
