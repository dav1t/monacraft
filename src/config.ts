import type { AnthropicEffort } from './llm/anthropic.ts'
import type { OllamaMode, ThinkSetting } from './llm/ollama.ts'
import type { AnthropicSettings, LLMSettings, OllamaSettings, OpenAISettings } from './llm/providers.ts'

export interface Config {
  minecraft: { host: string; port: number; username: string; version: string }
  /** The provider picked by LLM_PROVIDER. */
  llm: LLMSettings
  /** Settings for every provider, so the panel can switch between them. */
  providers: { ollama: OllamaSettings; openai: OpenAISettings; anthropic: AnthropicSettings }
  dbPath: string
  panel: { host: string; port: number }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values count as unset, so `MC_HOST=` falls back to the default.
  const get = (name: string): string | undefined => env[name] || undefined
  const provider = get('LLM_PROVIDER') ?? 'ollama'
  if (provider !== 'ollama' && provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`LLM_PROVIDER must be "ollama", "openai" or "anthropic" (got "${provider}")`)
  }
  const providers: Config['providers'] = {
    ollama: {
      provider: 'ollama',
      host: get('OLLAMA_HOST') ?? 'http://127.0.0.1:11434',
      model: get('OLLAMA_MODEL') ?? 'qwen3:8b',
      mode: parseMode(get('OLLAMA_MODE')),
      think: parseThink(get('OLLAMA_THINK')),
      numCtx: parseNumCtx(get('OLLAMA_NUM_CTX')),
    },
    openai: {
      provider: 'openai',
      baseURL: get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: get('OPENAI_MODEL') ?? 'gpt-5-mini',
      apiKey: get('OPENAI_API_KEY') ?? '',
    },
    anthropic: {
      provider: 'anthropic',
      model: get('ANTHROPIC_MODEL') ?? 'claude-opus-5-5',
      effort: parseEffort(get('ANTHROPIC_EFFORT')),
      apiKey: get('ANTHROPIC_API_KEY') ?? '',
    },
  }
  return {
    minecraft: {
      host: get('MC_HOST') ?? 'localhost',
      port: parsePort(get('MC_PORT')),
      username: get('MC_USERNAME') ?? 'Mindy',
      version: get('MC_VERSION') ?? '1.21.11',
    },
    llm: providers[provider],
    providers,
    dbPath: get('DB_PATH') ?? 'data/agent.db',
    panel: { host: get('PANEL_HOST') ?? '127.0.0.1', port: parsePort(get('PANEL_PORT'), 'PANEL_PORT', 3000) },
  }
}

export function parsePort(value: string | undefined, name = 'MC_PORT', fallback = 25565): number {
  if (value === undefined) return fallback
  const port = Number(value)
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer 1-65535 (got "${value}")`)
  }
  return port
}

function parseMode(value: string | undefined): OllamaMode {
  if (value === undefined || value === 'tools') return 'tools'
  if (value === 'json') return 'json'
  throw new Error(`OLLAMA_MODE must be "tools" or "json" (got "${value}")`)
}

function parseNumCtx(value: string | undefined): number {
  if (value === undefined) return 8192
  const n = Number(value)
  if (!/^\d+$/.test(value) || n < 2048) throw new Error(`OLLAMA_NUM_CTX must be an integer >= 2048 (got "${value}")`)
  return n
}

/** Thinking makes qwen3 far too slow on modest GPUs, so it is off unless asked for. */
function parseThink(value: string | undefined): ThinkSetting {
  if (value === undefined) return false
  if (value === 'true' || value === 'false') return value === 'true'
  if (value === 'low' || value === 'medium' || value === 'high') return value
  throw new Error(`OLLAMA_THINK must be true, false, low, medium or high (got "${value}")`)
}

const EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function parseEffort(value: string | undefined): AnthropicEffort {
  if (value === undefined) return 'medium'
  if ((EFFORTS as readonly string[]).includes(value)) return value as AnthropicEffort
  throw new Error(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')} (got "${value}")`)
}
