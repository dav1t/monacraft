import { AnthropicProvider, type AnthropicEffort } from './anthropic.ts'
import { OllamaProvider, type OllamaMode, type ThinkSetting } from './ollama.ts'
import { OpenAIProvider } from './openai.ts'
import type { DecideRequest, Decision, LLMProvider } from './types.ts'

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

export type LLMSettings = OllamaSettings | OpenAISettings | AnthropicSettings
export type ProviderId = LLMSettings['provider']

export function createProvider(settings: LLMSettings): LLMProvider {
  switch (settings.provider) {
    case 'ollama':
      return new OllamaProvider(settings)
    case 'openai':
      return new OpenAIProvider(settings)
    case 'anthropic':
      return new AnthropicProvider(settings)
  }
}

/** Delegates to a provider that can be replaced while the agent runs; a request in flight finishes on the old one. */
export class SwitchableProvider implements LLMProvider {
  #current: LLMProvider
  #waiters: (() => void)[] = []

  constructor(initial: LLMProvider) {
    this.#current = initial
  }

  get name(): string {
    return this.#current.name
  }

  set(provider: LLMProvider): void {
    this.#current = provider
    for (const wake of this.#waiters.splice(0)) wake()
  }

  /** Resolves the next time the provider is replaced. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  decide(request: DecideRequest): Promise<Decision> {
    return this.#current.decide(request)
  }
}
