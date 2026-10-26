import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('has local defaults', () => {
    const config = loadConfig({})
    expect(config).toMatchObject({
      minecraft: { host: 'localhost', port: 25565, username: 'Mindy', version: '1.21.11' },
      llm: { provider: 'ollama', host: 'http://127.0.0.1:11434', model: 'qwen3:8b', mode: 'tools', think: false, numCtx: 8192 },
      dbPath: 'data/agent.db',
      panel: { host: '127.0.0.1', port: 3000 },
    })
    expect(config.providers.openai).toEqual({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: '' })
    expect(config.providers.anthropic).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', apiKey: '' })
  })

  it('reads overrides', () => {
    const config = loadConfig({ MC_PORT: '25566', OLLAMA_MODEL: 'gemma3:4b', OLLAMA_MODE: 'json', OLLAMA_THINK: 'false' })
    expect(config.minecraft.port).toBe(25566)
    expect(config.llm).toMatchObject({ model: 'gemma3:4b', mode: 'json', think: false })
    expect(loadConfig({ OLLAMA_THINK: 'low' }).providers.ollama.think).toBe('low')
    expect(loadConfig({ OLLAMA_THINK: 'true' }).providers.ollama.think).toBe(true)
    expect(loadConfig({ OLLAMA_THINK: '' }).providers.ollama.think).toBe(false)
    expect(loadConfig({ OLLAMA_NUM_CTX: '16384' }).providers.ollama.numCtx).toBe(16384)
    expect(loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_EFFORT: 'high', ANTHROPIC_API_KEY: 'k' }).llm).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'high',
      apiKey: 'k',
    })
    expect(loadConfig({ LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:1234/v1' }).llm).toMatchObject({ baseURL: 'http://localhost:1234/v1' })
    expect(loadConfig({ PANEL_PORT: '8080' }).panel.port).toBe(8080)
  })

  it('rejects bad values', () => {
    expect(() => loadConfig({ OLLAMA_THINK: 'maybe' })).toThrow(/OLLAMA_THINK/)
    expect(() => loadConfig({ OLLAMA_MODE: 'chat' })).toThrow(/OLLAMA_MODE/)
    expect(() => loadConfig({ OLLAMA_NUM_CTX: 'big' })).toThrow(/OLLAMA_NUM_CTX/)
    expect(() => loadConfig({ OLLAMA_NUM_CTX: '1024' })).toThrow(/OLLAMA_NUM_CTX/)
    expect(() => loadConfig({ LLM_PROVIDER: 'claude' })).toThrow(/LLM_PROVIDER/)
    expect(() => loadConfig({ MC_PORT: 'abc' })).toThrow(/MC_PORT/)
    expect(() => loadConfig({ MC_PORT: '70000' })).toThrow(/MC_PORT/)
    expect(() => loadConfig({ MC_PORT: '0' })).toThrow(/MC_PORT/)
    expect(() => loadConfig({ ANTHROPIC_EFFORT: 'huge' })).toThrow(/ANTHROPIC_EFFORT/)
    expect(() => loadConfig({ PANEL_PORT: 'x' })).toThrow(/PANEL_PORT/)
  })

  it('treats empty values as unset', () => {
    expect(loadConfig({ MC_HOST: '' }).minecraft.host).toBe('localhost')
    expect(loadConfig({ MC_PORT: '' }).minecraft.port).toBe(25565)
    expect(loadConfig({ DB_PATH: '' }).dbPath).toBe('data/agent.db')
  })
})
