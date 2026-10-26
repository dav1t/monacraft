import type { OllamaMode, ThinkSetting } from './llm/ollama.ts'

export interface Config {
  minecraft: { host: string; port: number; username: string; version: string }
  llm: { host: string; model: string; mode: OllamaMode; think: ThinkSetting; numCtx: number }
  dbPath: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values count as unset, so `MC_HOST=` falls back to the default.
  const get = (name: string): string | undefined => env[name] || undefined
  const provider = get('LLM_PROVIDER') ?? 'ollama'
  if (provider !== 'ollama') throw new Error(`LLM_PROVIDER "${provider}" is not supported yet (use "ollama")`)
  return {
    minecraft: {
      host: get('MC_HOST') ?? 'localhost',
      port: parsePort(get('MC_PORT')),
      username: get('MC_USERNAME') ?? 'Mindy',
      version: get('MC_VERSION') ?? '1.21.11',
    },
    llm: {
      host: get('OLLAMA_HOST') ?? 'http://127.0.0.1:11434',
      model: get('OLLAMA_MODEL') ?? 'qwen3:8b',
      mode: parseMode(get('OLLAMA_MODE')),
      think: parseThink(get('OLLAMA_THINK')),
      numCtx: parseNumCtx(get('OLLAMA_NUM_CTX')),
    },
    dbPath: get('DB_PATH') ?? 'data/agent.db',
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 25565
  const port = Number(value)
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`MC_PORT must be an integer 1-65535 (got "${value}")`)
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
