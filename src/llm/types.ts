import type { ToolSpec } from '../tools/types.ts'

export interface Decision {
  thought: string
  tool: string
  args: Record<string, unknown>
  /** Tokens the model read for this decision (system prompt, tools and prompt), when the provider reports it. */
  promptTokens?: number
}

/** A piece of the reply as the model writes it: hidden reasoning, visible text, or tool-call arguments. */
export interface StreamDelta {
  kind: 'thinking' | 'text' | 'tool'
  text: string
}

export interface DecideRequest {
  system: string
  user: string
  tools: ToolSpec[]
  /** When set, the provider streams and reports the reply as it arrives. */
  onStream?: (delta: StreamDelta) => void
}

/** What the last decision's tool call returned. */
export interface ToolOutcome {
  outcome: string
  isError: boolean
}

export interface ConverseRequest {
  /** The full prompt on the first turn, a short update after that. */
  user: string
  /** The result of the previous decision's tool call. */
  result?: ToolOutcome
  onStream?: (delta: StreamDelta) => void
}

/**
 * A conversation the model keeps across steps: it sees its own earlier calls and reasoning instead of a fresh prompt
 * each time. Turns are only ever appended.
 */
export interface Conversation {
  next(request: ConverseRequest): Promise<Decision>
  /** Tokens the model read for the last turn; the conversation is replaced before it grows too long. */
  readonly contextTokens: number
  /** Set when the conversation cannot continue (e.g. after a refusal); start a new one. */
  readonly closed: boolean
}

/** Picks exactly one tool call per request. Implementations: Ollama, OpenAI-compatible, Anthropic. */
export interface LLMProvider {
  readonly name: string
  /** Context window in tokens, when known (Ollama's num_ctx). */
  readonly contextWindow?: number
  decide(request: DecideRequest): Promise<Decision>
  /** Providers that can hold a conversation; the others get a fresh prompt every step through decide(). */
  readonly startConversation?: (setup: { system: string; tools: ToolSpec[] }) => Conversation
}

/** The model answered, but not with a usable tool call. */
export class LLMFormatError extends Error {
  override name = 'LLMFormatError'
}

/** The provider can never work with this setup (e.g. the model lacks tool support); retrying is pointless. */
export class FatalLLMError extends Error {
  override name = 'FatalLLMError'
}
