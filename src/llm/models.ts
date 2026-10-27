import { OPENROUTER_URL, type LLMSettings } from './providers.ts'

export interface ModelInfo {
  id: string
  /** A display name, when the provider has one. */
  name?: string
}

/** Requests to list models give up after this long, so a dead host does not hang the panel. */
const TIMEOUT_MS = 10_000

/** The models the provider offers, sorted by id; OpenRouter's only those that can call tools. Throws when the list cannot be loaded. */
export async function listModels(settings: LLMSettings, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const get = async <T>(url: string, headers: Record<string, string> = {}): Promise<T> => {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`listing models failed: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  let models: ModelInfo[]
  switch (settings.provider) {
    case 'ollama': {
      const body = await get<{ models: { name: string }[] }>(`${trimSlash(settings.host)}/api/tags`)
      models = body.models.map((m) => ({ id: m.name }))
      break
    }
    case 'openai': {
      const body = await get<{ data: { id: string }[] }>(
        `${trimSlash(settings.baseURL)}/models`,
        settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      )
      models = body.data.map((m) => ({ id: m.id }))
      break
    }
    case 'openrouter': {
      const body = await get<{ data: { id: string; name?: string; supported_parameters?: string[] }[] }>(
        `${OPENROUTER_URL}/models?supported_parameters=tools`,
      )
      models = body.data.filter((m) => m.supported_parameters?.includes('tools')).map((m) => ({ id: m.id, ...(m.name && { name: m.name }) }))
      break
    }
    case 'anthropic': {
      const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('no Anthropic API key to list models with')
      const body = await get<{ data: { id: string; display_name?: string }[] }>('https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      })
      models = body.data.map((m) => ({ id: m.id, ...(m.display_name && { name: m.display_name }) }))
      break
    }
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
