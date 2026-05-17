import { Message, StreamDelta } from "../core/types.js";

export interface ProviderRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Message[];
  /** Kept as a typed slot for forward-compat. The CLI doesn't consume it. */
  tools: unknown[];
}

export interface ChatProvider {
  readonly id: string;
  stream(req: ProviderRequest): AsyncIterable<StreamDelta>;
}
