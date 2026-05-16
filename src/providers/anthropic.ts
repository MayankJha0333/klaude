import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  Tool as AnthropicTool
} from "@anthropic-ai/sdk/resources/messages";
import { ChatProvider, ProviderRequest } from "./base.js";
import { ContentBlock, Message, StreamDelta } from "../core/types.js";

type ContentBlockParam = TextBlockParam | ToolUseBlockParam | ToolResultBlockParam;

const MAX_RETRIES = 4;

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamDelta> {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      tools: req.tools.map<AnthropicTool>((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as AnthropicTool.InputSchema
      })),
      messages: req.messages.map(toAnthropicMessage)
    };

    let attempt = 0;
    while (true) {
      try {
        // Use `messages.create({stream:true}).withResponse()` rather than
        // `messages.stream(...)` so we can access the raw `Response` object
        // and read Anthropic's authoritative rate-limit headers:
        //   anthropic-ratelimit-tokens-limit / -remaining / -reset
        //   anthropic-ratelimit-input-tokens-limit / -remaining / -reset
        //   anthropic-ratelimit-output-tokens-limit / -remaining / -reset
        //   anthropic-ratelimit-requests-limit / -remaining / -reset
        // These are the exact same numbers Anthropic uses to enforce the
        // quota, so the TokenMeter can show server-truth instead of a
        // client-side guess.
        const apiPromise = this.client.messages.create({
          ...params,
          stream: true
        });
        const withResp = await apiPromise.withResponse();
        const rawStream = withResp.data;
        const headers = withResp.response.headers;
        const limits = parseRateLimitHeaders(headers);
        if (limits) {
          yield {
            type: "usage",
            usage: { inputTokens: 0, outputTokens: 0, rateLimit: limits }
          };
        }

        // Track prompt-side counts seen on message_start so we can emit a
        // single authoritative usage delta once output_tokens is final.
        let promptUsage: {
          inputTokens: number;
          cacheReadTokens?: number;
          cacheCreatedTokens?: number;
        } | null = null;
        for await (const event of rawStream) {
          switch (event.type) {
            case "message_start":
              if (event.message?.usage) {
                // Cast: older @anthropic-ai/sdk types omit cache_*_input_tokens.
                // The fields are present on the wire — cast through unknown so
                // tsc doesn't reject the runtime-safe access.
                const u = event.message.usage as unknown as {
                  input_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
                promptUsage = {
                  inputTokens: u.input_tokens ?? 0,
                  cacheReadTokens: u.cache_read_input_tokens ?? undefined,
                  cacheCreatedTokens: u.cache_creation_input_tokens ?? undefined
                };
              }
              break;
            case "content_block_start":
              if (event.content_block.type === "tool_use") {
                yield {
                  type: "tool_use_start",
                  tool: { id: event.content_block.id, name: event.content_block.name }
                };
              }
              break;
            case "content_block_delta":
              if (event.delta.type === "text_delta") {
                yield { type: "text", text: event.delta.text };
              } else if (event.delta.type === "input_json_delta") {
                yield { type: "tool_use_input", partialInput: event.delta.partial_json };
              }
              break;
            case "content_block_stop":
              yield { type: "tool_use_end" };
              break;
            case "message_delta":
              // The SDK reports the final, authoritative output_tokens here.
              if (event.usage && promptUsage) {
                yield {
                  type: "usage",
                  usage: {
                    inputTokens: promptUsage.inputTokens,
                    outputTokens: event.usage.output_tokens ?? 0,
                    cacheReadTokens: promptUsage.cacheReadTokens,
                    cacheCreatedTokens: promptUsage.cacheCreatedTokens,
                    rateLimit: limits ?? undefined
                  }
                };
              }
              break;
            case "message_stop":
              yield { type: "done" };
              break;
          }
        }
        return;
      } catch (err) {
        const info = parseError(err);

        if (info.status === 429 && attempt < MAX_RETRIES) {
          const waitMs = info.retryAfterMs ?? backoffMs(attempt);
          yield {
            type: "text",
            text: `\n[rate limited — retrying in ${Math.round(waitMs / 1000)}s (${
              attempt + 1
            }/${MAX_RETRIES})]\n`
          };
          await sleep(waitMs);
          attempt++;
          continue;
        }

        if ((info.status === 529 || info.status === 503) && attempt < MAX_RETRIES) {
          const waitMs = backoffMs(attempt);
          yield { type: "text", text: `\n[overloaded — retry in ${Math.round(waitMs / 1000)}s]\n` };
          await sleep(waitMs);
          attempt++;
          continue;
        }

        yield { type: "error", error: humanize(info) };
        return;
      }
    }
  }
}

interface ErrInfo {
  status?: number;
  message: string;
  type?: string;
  retryAfterMs?: number;
}

function parseError(err: unknown): ErrInfo {
  const e = err as {
    status?: number;
    message?: string;
    headers?: Record<string, string>;
    error?: { error?: { type?: string; message?: string } };
  };
  if (e && typeof e.status === "number") {
    const headers = e.headers ?? {};
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    const body = e.error;
    return {
      status: e.status,
      message: body?.error?.message || e.message || "",
      type: body?.error?.type,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
    };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  const jitter = Math.random() * 400;
  return Math.min(base + jitter, 30_000);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull Anthropic's authoritative rate-limit info out of a `Response`'s
 * headers. Anthropic sends `anthropic-ratelimit-*` headers on *every*
 * response, both success and 429. These are the same numbers the UI on
 * claude.ai's Usage page uses, so surfacing them in the meter lets us
 * show server-truth rather than a client-side estimate.
 *
 * Returns `null` when no rate-limit headers are present (some endpoints
 * or proxy configurations may strip them).
 */
function parseRateLimitHeaders(
  headers: { get(name: string): string | null }
): RateLimitInfo | null {
  const num = (k: string): number | undefined => {
    const v = headers.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const reset = (k: string): number | undefined => {
    const v = headers.get(k);
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  };

  const out: RateLimitInfo = {
    tokens: {
      limit: num("anthropic-ratelimit-tokens-limit"),
      remaining: num("anthropic-ratelimit-tokens-remaining"),
      resetsAt: reset("anthropic-ratelimit-tokens-reset")
    },
    inputTokens: {
      limit: num("anthropic-ratelimit-input-tokens-limit"),
      remaining: num("anthropic-ratelimit-input-tokens-remaining"),
      resetsAt: reset("anthropic-ratelimit-input-tokens-reset")
    },
    outputTokens: {
      limit: num("anthropic-ratelimit-output-tokens-limit"),
      remaining: num("anthropic-ratelimit-output-tokens-remaining"),
      resetsAt: reset("anthropic-ratelimit-output-tokens-reset")
    },
    requests: {
      limit: num("anthropic-ratelimit-requests-limit"),
      remaining: num("anthropic-ratelimit-requests-remaining"),
      resetsAt: reset("anthropic-ratelimit-requests-reset")
    }
  };

  // If every bucket is empty, treat as absent so the meter falls back to
  // local aggregation rather than showing all-zero quotas.
  const anyKnown =
    out.tokens.limit !== undefined ||
    out.inputTokens.limit !== undefined ||
    out.outputTokens.limit !== undefined ||
    out.requests.limit !== undefined;
  return anyKnown ? out : null;
}

export interface RateLimitBucket {
  limit?: number;
  remaining?: number;
  resetsAt?: number;
}

export interface RateLimitInfo {
  tokens: RateLimitBucket;
  inputTokens: RateLimitBucket;
  outputTokens: RateLimitBucket;
  requests: RateLimitBucket;
}

function humanize(info: ErrInfo): string {
  if (info.status === 429) return `Rate limited (429). ${info.message}`;
  if (info.status === 401 || info.status === 403)
    return `Auth rejected (${info.status}). Token invalid. Logout and reconnect. ${info.message}`;
  if (info.status === 529 || info.status === 503)
    return `Anthropic API overloaded (${info.status}). Try again shortly. ${info.message}`;
  if (info.status) return `${info.status} ${info.type ?? ""}: ${info.message}`.trim();
  return info.message;
}

function toAnthropicMessage(m: Message): MessageParam {
  if (typeof m.content === "string") {
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
  }
  const blocks: ContentBlockParam[] = m.content.map<ContentBlockParam>((b: ContentBlock) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
  });
  return { role: m.role === "assistant" ? "assistant" : "user", content: blocks };
}
