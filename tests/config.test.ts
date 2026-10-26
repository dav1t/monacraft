import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('has local defaults', () => {
    expect(loadConfig({})).toEqual({
      minecraft: { host: 'localhost', port: 25565, username: 'Mindy', version: '1.21.11' },
      llm: { host: 'http://127.0.0.1:11434', model: 'qwen3:8b', mode: 'tools', think: false, numCtx: 8192 },
      dbPath: 'data/agent.db',
    })
  })

  it('reads overrides', () => {
    const config = loadConfig({ MC_PORT: '25566', OLLAMA_MODEL: 'gemma3:4b', OLLAMA_MODE: 'json', OLLAMA_THINK: 'false' })
    expect(config.minecraft.port).toBe(25566)
    expect(config.llm).toMatchObject({ model: 'gemma3:4b', mode: 'json', think: false })
    expect(loadConfig({ OLLAMA_THINK: 'low' }).llm.think).toBe('low')
    expect(loadConfig({ OLLAMA_THINK: 'true' }).llm.think).toBe(true)
    expect(loadConfig({ OLLAMA_THINK: '' }).llm.think).toBe(false)
    expect(loadConfig({ OLLAMA_NUM_CTX: '16384' }).llm.numCtx).toBe(16384)
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
  })

  it('treats empty values as unset', () => {
    expect(loadConfig({ MC_HOST: '' }).minecraft.host).toBe('localhost')
    expect(loadConfig({ MC_PORT: '' }).minecraft.port).toBe(25565)
    expect(loadConfig({ DB_PATH: '' }).dbPath).toBe('data/agent.db')
  })
})
