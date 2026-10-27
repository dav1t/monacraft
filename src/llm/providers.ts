import { errorMessage } from '../lib/text.ts'
import { AnthropicProvider, type AnthropicEffort } from './anthropic.ts'
import { OllamaProvider, type OllamaMode, type ThinkSetting } from './ollama.ts'
import { OpenAIProvider } from './openai.ts'
import { LLMFormatError, type Conversation, type DecideRequest, type Decision, type LLMProvider, type Usage } from './types.ts'

export interface OllamaSettings {
  provider: 'ollama'
  host: string
  model: string
  mode: OllamaMode
  think: ThinkSetting
  numCtx: number
}

export interface OpenAISettings {
  provider: 'openai'
  baseURL: string
  model: string
  apiKey: string
}

export interface AnthropicSettings {
  provider: 'anthropic'
  model: string
  effort: AnthropicEffort
  apiKey: string
}

export interface OpenRouterSettings {
  provider: 'openrouter'
  model: string
  apiKey: string
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

export type LLMSettings = OllamaSettings | OpenAISettings | AnthropicSettings | OpenRouterSettings
export type ProviderId = LLMSettings['provider']

export function createProvider(settings: LLMSettings): LLMProvider {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings)
    case 'openai':
      return new OpenAIProvider(settings)
    case 'anthropic':
      return new AnthropicProvider(settings)
    case 'openrouter':
      // Usage accounting makes OpenRouter report each request's cost.
      return new OpenAIProvider({ ...settings, baseURL: OPENROUTER_URL, label: 'openrouter', extraBody: { usage: { include: true } } })
  }
}

/** Which model a call went to. */
export interface ModelLabel {
  provider: ProviderId
  model: string
}

/** One model call, for usage stats. */
export interface CallRecord extends ModelLabel {
  kind: 'decision' | 'reflection'
  usage: Usage
  durationMs: number
  /** Set when the call threw: an unusable reply, a network error, a rate limit, a bad key or model. */
  error?: string
}

export function labelOf(settings: LLMSettings): ModelLabel {
  return { provider: settings.provider, model: settings.model }
}

/**
 * Delegates to a provider that can be replaced while the agent runs; a request in flight finishes on the old one.
 * Every call, conversation turns included, is reported to `onCall` under the model it started on.
 */
export class SwitchableProvider implements LLMProvider {
  #current: LLMProvider
  #label: ModelLabel
  #waiters: (() => void)[] = []
  readonly #onCall: (record: CallRecord) => void

  constructor(initial: LLMProvider, label: ModelLabel, onCall: (record: CallRecord) => void = () => {}) {
    this.#current = initial
    this.#label = label
    this.#onCall = onCall
  }

  get label(): ModelLabel {
    return this.#label
  }

  get name(): string {
    return this.#current.name
  }

  get contextWindow(): number | undefined {
    return this.#current.contextWindow
  }

  set(provider: LLMProvider, label: ModelLabel): void {
    this.#current = provider
    this.#label = label
    for (const wake of this.#waiters.splice(0)) wake()
  }

  /** Resolves the next time the provider is replaced. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  decide(request: DecideRequest): Promise<Decision> {
    return this.#record(request.purpose ?? 'decision', this.#label, () => this.#current.decide(request))
  }

  /** A conversation stays with the provider that started it; the agent starts a new one when the name changes. */
  get startConversation(): LLMProvider['startConversation'] {
    const start = this.#current.startConversation
    if (!start) return undefined
    return (setup) => {
      const conversation = start(setup)
      const label = this.#label
      const record = this.#record.bind(this)
      return {
        next: (request) => record('decision', label, () => conversation.next(request)),
        get contextTokens() {
          return conversation.contextTokens
        },
        get closed() {
          return conversation.closed
        },
      } satisfies Conversation
    }
  }

  async #record(kind: CallRecord['kind'], label: ModelLabel, call: () => Promise<Decision>): Promise<Decision> {
    const started = Date.now()
    const report = (usage: Usage | undefined, error?: string) =>
      this.#onCall({ ...label, kind, usage: usage ?? {}, durationMs: Date.now() - started, ...(error !== undefined && { error }) })
    try {
      const decision = await call()
      report(decision.usage)
      return decision
    } catch (err) {
      report(err instanceof LLMFormatError ? err.usage : undefined, errorMessage(err))
      throw err
    }
  }
}
