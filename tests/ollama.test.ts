import type { ChatRequest, Message, Ollama } from 'ollama'
import { describe, expect, it } from 'vitest'
import { OllamaProvider } from '../src/llm/ollama.ts'
import { FatalLLMError, LLMFormatError } from '../src/llm/types.ts'
import type { ToolSpec } from '../src/tools/types.ts'

function fakeClient(message: Partial<Message>) {
  const requests: ChatRequest[] = []
  const client = {
    chat: async (request: ChatRequest) => {
      requests.push(request)
      return { message: { role: 'assistant', content: '', ...message } }
    },
  }
  return { requests, client: client as unknown as Pick<Ollama, 'chat'> }
}

const tools: ToolSpec[] = [
  {
    name: 'mine',
    description: 'Mine blocks',
    parameters: { type: 'object', properties: { block_type: { type: 'string' }, count: { type: 'integer' } }, required: ['block_type'] },
  },
  { name: 'say', description: 'Chat', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
]
const request = { system: 'SYS', user: 'USER', tools }

describe('OllamaProvider in tools mode', () => {
  it('sends native tool definitions and reads the tool call', async () => {
    const { client, requests } = fakeClient({
      content: 'Need wood.',
      tool_calls: [{ function: { name: 'mine', arguments: { block_type: 'oak_log', count: 3 } } }],
    })
    const provider = new OllamaProvider({ model: 'qwen3:8b', mode: 'tools', client })
    expect(await provider.decide(request)).toEqual({ thought: 'Need wood.', tool: 'mine', args: { block_type: 'oak_log', count: 3 } })
    expect(requests[0]).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }],
      tools: [{ type: 'function', function: { name: 'mine' } }, { type: 'function', function: { name: 'say' } }],
    })
    expect(requests[0]).not.toHaveProperty('think')
    expect(requests[0]?.options).toMatchObject({ temperature: 0.4 })
  })

  it('sends num_ctx when configured', async () => {
    const { client, requests } = fakeClient({ content: '{"tool":"say","args":{}}' })
    await new OllamaProvider({ model: 'm', mode: 'tools', numCtx: 8192, client }).decide(request)
    expect(requests[0]?.options).toMatchObject({ num_ctx: 8192 })
  })

  it('turns "does not support tools" into a FatalLLMError', async () => {
    const client = {
      chat: async () => {
        throw new Error('registry.ollama.ai/library/gemma3:4b does not support tools')
      },
    } as unknown as Pick<Ollama, 'chat'>
    const provider = new OllamaProvider({ model: 'gemma3:4b', mode: 'tools', client })
    const err = await provider.decide(request).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FatalLLMError)
    expect((err as Error).message).toBe('gemma3:4b does not support tool calling — switch the Ollama mode to json (OLLAMA_MODE=json)')
  })

  it('accepts a tool call written as JSON text', async () => {
    const { client } = fakeClient({ content: 'Calling: {"tool": "say", "args": {"message": "hi"}}' })
    const provider = new OllamaProvider({ model: 'm', mode: 'tools', client })
    expect(await provider.decide(request)).toEqual({ thought: '', tool: 'say', args: { message: 'hi' } })
  })

  it('throws LLMFormatError when the model only talks', async () => {
    const { client } = fakeClient({ content: 'I like trees.' })
    const provider = new OllamaProvider({ model: 'm', mode: 'tools', client })
    await expect(provider.decide(request)).rejects.toThrow(LLMFormatError)
  })
})

describe('OllamaProvider in json mode', () => {
  it('constrains output with a schema and lists tools in the system prompt', async () => {
    const { client, requests } = fakeClient({ content: '{"thought":"chat back","tool":"say","args":{"message":"hey"}}' })
    const provider = new OllamaProvider({ model: 'gemma3:4b', mode: 'json', think: false, client })
    expect(await provider.decide(request)).toEqual({ thought: 'chat back', tool: 'say', args: { message: 'hey' } })
    const sent = requests[0]
    expect(sent?.tools).toBeUndefined()
    expect(sent?.think).toBe(false)
    expect(sent?.format).toMatchObject({ properties: { tool: { enum: ['mine', 'say'] } } })
    expect(sent?.messages?.[0]?.content).toContain('- mine(block_type: string, count?: integer) — Mine blocks')
  })

  it('rejects replies naming unknown tools', async () => {
    const { client } = fakeClient({ content: '{"thought":"","tool":"fly","args":{}}' })
    const provider = new OllamaProvider({ model: 'm', mode: 'json', client })
    await expect(provider.decide(request)).rejects.toThrow(LLMFormatError)
  })
})

describe('OllamaProvider streaming', () => {
  it('streams thinking, text and tool calls when someone listens', async () => {
    const parts: Partial<Message>[] = [
      { thinking: 'need ' },
      { thinking: 'wood' },
      { content: 'Chopping.' },
      { tool_calls: [{ function: { name: 'mine', arguments: { block_type: 'oak_log' } } }] },
    ]
    const requests: ChatRequest[] = []
    const client = {
      chat: async (req: ChatRequest) => {
        requests.push(req)
        return (async function* () {
          for (const part of parts) yield { message: { role: 'assistant', content: '', ...part } }
        })()
      },
    } as unknown as Pick<Ollama, 'chat'>
    const deltas: string[] = []
    const provider = new OllamaProvider({ model: 'm', mode: 'tools', client })
    const decision = await provider.decide({ ...request, onStream: (d) => deltas.push(`${d.kind}:${d.text}`) })
    expect(requests[0]?.stream).toBe(true)
    expect(decision).toEqual({ thought: 'Chopping.', tool: 'mine', args: { block_type: 'oak_log' } })
    expect(deltas).toEqual(['thinking:need ', 'thinking:wood', 'text:Chopping.', 'tool:mine {"block_type":"oak_log"}'])
  })
})

describe('OllamaProvider token counts', () => {
  it('reports the prompt tokens Ollama counted and its context window', async () => {
    const requests: ChatRequest[] = []
    const client = {
      chat: async (r: ChatRequest) => {
        requests.push(r)
        const message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'say', arguments: { message: 'hi' } } }] }
        return { message, prompt_eval_count: 1831 }
      },
    } as unknown as Pick<Ollama, 'chat'>
    const provider = new OllamaProvider({ model: 'qwen3:8b', mode: 'tools', numCtx: 8192, client })
    expect(provider.contextWindow).toBe(8192)
    expect(await provider.decide(request)).toMatchObject({ tool: 'say', promptTokens: 1831 })
  })
})
