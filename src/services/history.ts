import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { Message, TimelineEvent } from "../core/types.js";

/**
 * Persists chat sessions under VS Code's per-extension globalStorage.
 * Each session is a single JSON file: {dir}/sessions/{sessionId}.json.
 * Saves are intentionally idempotent overwrites — we always rewrite the
 * whole session on each save call. Callers should debounce.
 */
export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  timeline: TimelineEvent[];
  /** Claude CLI session id used with `claude --resume`. Subscription-mode only. */
  resumeId?: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
}

export class HistoryService {
  private dir: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = path.join(ctx.globalStorageUri.fsPath, "sessions");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(session: StoredSession): Promise<void> {
    if (!hasUserContent(session)) {
      // Never persist an empty placeholder — and if a previously-saved
      // session has since lost all its user content (e.g. rewound to empty),
      // remove the stale file instead of silently skipping, otherwise a
      // reload would resurrect it via restoreLatestSession.
      await this.delete(session.id).catch(() => undefined);
      return;
    }
    await this.ensureReady();
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session));
    await fs.rename(tmp, file);
  }

  async list(): Promise<HistoryEntry[]> {
    await this.ensureReady();
    const files = await fs.readdir(this.dir).catch(() => []);
    const entries: HistoryEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, f), "utf8");
        const s = JSON.parse(raw) as StoredSession;
        entries.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          eventCount: s.timeline?.length ?? 0
        });
      } catch {
        // ignore corrupt files
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }

  async load(id: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(path.join(this.dir, `${id}.json`), "utf8");
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await fs.unlink(path.join(this.dir, `${id}.json`)).catch(() => undefined);
  }
}

function hasUserContent(s: StoredSession): boolean {
  return s.timeline.some((e) => e.kind === "user");
}

/** Pull a short title from the first user message in the timeline. */
export function deriveTitle(timeline: TimelineEvent[]): string {
  const firstUser = timeline.find((e) => e.kind === "user");
  if (!firstUser?.body) return "New chat";
  const oneLine = firstUser.body.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
}
