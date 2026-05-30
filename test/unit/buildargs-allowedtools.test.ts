import { describe, it, expect } from "vitest";
import { buildArgs } from "../../src/providers/claude-cli.js";

// Focused on the auto-mode tool pre-allow list. The existing claude-cli.test.ts
// only checks a simple "^npm test$" pattern's presence; these exercise the
// regex→CLI-pattern translation with the DEFAULT config patterns (which use
// alternation) and the MCP server pre-allow paths.

const base = { binary: "claude", cwd: "/tmp" } as const;

function allowedToolsArgs(args: string[]): string[] {
  const i = args.indexOf("--allowedTools");
  if (i === -1) return [];
  // Everything after --allowedTools up to the next flag.
  const out: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    if (args[j].startsWith("--")) break;
    out.push(args[j]);
  }
  return out;
}

describe("buildArgs auto-mode allowedTools", () => {
  it("pre-allows the standard read/edit tools in auto mode", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^npm test$"]
    });
    const tools = allowedToolsArgs(args);
    for (const t of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      expect(tools).toContain(t);
    }
  });

  it("pre-allows connected MCP servers as mcp__<server> in auto mode", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      mcpServerNames: ["linear", "notion"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("mcp__linear");
    expect(tools).toContain("mcp__notion");
  });

  it("pre-allows MCP servers in DEFAULT mode too (explicit consent grant)", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "default",
      mcpServerNames: ["linear"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("mcp__linear");
  });

  // ───────────────────────────────────────────────────────────
  // KNOWN BUG: regexToCliPattern() leaves regex alternation intact.
  // The shipped default config in package.json is:
  //   "^git (status|diff|log|branch)$", "^npm (test|run test)$"
  // The CLI's --allowedTools Bash(<pattern>) expects a literal/glob prefix,
  // NOT a regex. The translation produces "Bash(npm (test|run test))", which
  // never matches "npm test", so the headline "auto-approve" feature silently
  // fails for the default patterns. See src/providers/claude-cli.ts:288-297
  // (the `.replace(/\([^)]+\)/g, (m) => m)` step is a no-op).
  // ───────────────────────────────────────────────────────────
  it("documents the actual (buggy) translation of the default config patterns", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^git (status|diff|log|branch)$", "^npm (test|run test)$"]
    });
    const tools = allowedToolsArgs(args);
    // The regex metacharacters survive verbatim into the CLI pattern:
    expect(tools).toContain("Bash(git (status|diff|log|branch))");
    expect(tools).toContain("Bash(npm (test|run test))");
  });

  it.fails(
    "auto-approve patterns should translate to literal CLI globs (no regex alternation)",
    () => {
      const args = buildArgs("hi", "sonnet", {
        ...base,
        permissionMode: "auto",
        allowedBashPatterns: ["^npm (test|run test)$"]
      });
      const bash = allowedToolsArgs(args).filter((t) => t.startsWith("Bash("));
      // DESIRED: no Bash pattern should still contain regex alternation chars.
      for (const b of bash) {
        expect(b.includes("(") && b.includes("|")).toBe(false);
      }
    }
  );

  it("translates a simple anchored pattern by stripping the anchors", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^npm test$"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("Bash(npm test)");
  });
});
