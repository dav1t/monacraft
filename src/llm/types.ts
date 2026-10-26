import type { ToolSpec } from '../tools/types.ts'

export interface Decision {
  thought: string
  tool: string
  args: Record<string, unknown>
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

/** Picks exactly one tool call per request. Implementations: Ollama, OpenAI-compatible, Anthropic. */
export interface LLMProvider {
  readonly name: string
  decide(request: DecideRequest): Promise<Decision>
}

/** The model answered, but not with a usable tool call. */
export class LLMFormatError extends Error {
  override name = 'LLMFormatError'
}

/** The provider can never work with this setup (e.g. the model lacks tool support); retrying is pointless. */
export class FatalLLMError extends Error {
  override name = 'FatalLLMError'
}
