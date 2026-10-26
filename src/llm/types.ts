import type { ToolSpec } from '../tools/types.ts'

export interface Decision {
  thought: string
  tool: string
  args: Record<string, unknown>
}

export interface DecideRequest {
  system: string
  user: string
  tools: ToolSpec[]
}

/** Picks exactly one tool call per request. Implementations: Ollama now, Claude later. */
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
