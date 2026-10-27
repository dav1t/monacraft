import { describe, expect, it } from 'vitest'
import { listModels } from '../src/llm/models.ts'

/** A fetch that answers with `body` and records what was asked. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('listModels', () => {
  it('lists the models Ollama has pulled', async () => {
    const { fetchImpl, calls } = fakeFetch({ models: [{ name: 'qwen3:8b' }, { name: 'gemma3:4b' }] })
    const models = await listModels({ provider: 'ollama', host: 'http://127.0.0.1:11434', model: 'qwen3:8b', mode: 'tools', think: false, numCtx: 8192 }, fetchImpl)
    expect(models).toEqual([{ id: 'gemma3:4b' }, { id: 'qwen3:8b' }])
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('lists an OpenAI-compatible server with its key', async () => {
    const { fetchImpl, calls } = fakeFetch({ data: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] })
    const models = await listModels({ provider: 'openai', baseURL: 'https://api.openai.com/v1/', model: 'gpt-5-mini', apiKey: 'k' }, fetchImpl)
    expect(models).toEqual([{ id: 'gpt-5' }, { id: 'gpt-5-mini' }])
    expect(calls[0]).toEqual({ url: 'https://api.openai.com/v1/models', headers: { authorization: 'Bearer k' } })
  })

  it('lists only OpenRouter models that can call tools', async () => {
    const { fetchImpl, calls } = fakeFetch({
      data: [
        { id: 'z/tools', name: 'Z: Tools', supported_parameters: ['tools', 'temperature'] },
        { id: 'a/chat', name: 'A: Chat only', supported_parameters: ['temperature'] },
        { id: 'b/tools', name: 'B: Tools', supported_parameters: ['tools'] },
      ],
    })
    const models = await listModels({ provider: 'openrouter', model: 'z/tools', apiKey: '' }, fetchImpl)
    expect(models).toEqual([{ id: 'b/tools', name: 'B: Tools' }, { id: 'z/tools', name: 'Z: Tools' }])
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models?supported_parameters=tools')
  })

  it('lists Anthropic models with the API key', async () => {
    const { fetchImpl, calls } = fakeFetch({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] })
    const models = await listModels({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', apiKey: 'sk' }, fetchImpl)
    expect(models).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }])
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(calls[0]?.headers).toMatchObject({ 'x-api-key': 'sk', 'anthropic-version': '2023-06-01' })
  })

  it('fails with the status when the server refuses', async () => {
    const { fetchImpl } = fakeFetch({ error: 'nope' }, 401)
    await expect(listModels({ provider: 'openai', baseURL: 'http://x/v1', model: 'm', apiKey: '' }, fetchImpl)).rejects.toThrow(/401/)
  })
})
