import type Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../src/llm/anthropic.ts'
import { OpenAIProvider } from '../src/llm/openai.ts'
import { createProvider, labelOf, OPENROUTER_URL, SwitchableProvider, type CallRecord } from '../src/llm/providers.ts'
import { FatalLLMError, LLMFormatError, type Conversation, type Decision, type LLMProvider } from '../src/llm/types.ts'
import type { ToolSpec } from '../src/tools/types.ts'

const tools: ToolSpec[] = [
  { name: 'say', description: 'Chat', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
]
const request = { system: 'SYS', user: 'USER', tools }

function fakeOpenAI(chunks: unknown[]) {
  const requests: unknown[] = []
  const client = {
    chat: {
      completions: {
        create: async (body: unknown) => {
          requests.push(body)
          return (async function* () {
            yield* chunks
          })()
        },
      },
    },
  } as unknown as Pick<OpenAI, 'chat'>
  return { client, requests }
}

describe('OpenAIProvider', () => {
  it('assembles a streamed tool call and reports the pieces', async () => {
    const { client, requests } = fakeOpenAI([
      { choices: [{ delta: { reasoning_content: 'they greeted me' } }] },
      { choices: [{ delta: { content: 'Greeting back.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'say', arguments: '{"mess' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'age":"hi"}' } }] } }] },
    ])
    const deltas: string[] = []
    const provider = new OpenAIProvider({ baseURL: 'http://x/v1', model: 'm', client })
    const decision = await provider.decide({ ...request, onStream: (d) => deltas.push(d.kind) })
    expect(decision).toEqual({ thought: 'Greeting back.', tool: 'say', args: { message: 'hi' } })
    expect(deltas).toEqual(['thinking', 'text', 'tool', 'tool'])
    expect(requests[0]).toMatchObject({ model: 'm', stream: true, parallel_tool_calls: false, tools: [{ type: 'function', function: { name: 'say' } }] })
  })

  it('rejects invalid arguments and unknown tools', async () => {
    const bad = fakeOpenAI([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'say', arguments: '{oops' } }] } }] }])
    await expect(new OpenAIProvider({ baseURL: 'http://x', model: 'm', client: bad.client }).decide(request)).rejects.toThrow(LLMFormatError)
    const unknown = fakeOpenAI([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'fly', arguments: '{}' } }] } }] }])
    await expect(new OpenAIProvider({ baseURL: 'http://x', model: 'm', client: unknown.client }).decide(request)).rejects.toThrow(/unknown tool/)
  })

  it('reports usage and the cost the server sent', async () => {
    const { client } = fakeOpenAI([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'say', arguments: '{"message":"hi"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0012 } },
    ])
    const decision = await new OpenAIProvider({ baseURL: 'http://x', model: 'm', client }).decide(request)
    expect(decision.usage).toEqual({ inputTokens: 100, outputTokens: 20, cost: 0.0012 })
    expect(decision.promptTokens).toBe(100)
  })

  it('keeps the usage of an unusable reply on the format error', async () => {
    const { client } = fakeOpenAI([
      { choices: [{ delta: { content: 'just talking' } }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 3 } },
    ])
    const error = await new OpenAIProvider({ baseURL: 'http://x', model: 'm', client }).decide(request).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LLMFormatError)
    expect((error as LLMFormatError).usage).toEqual({ inputTokens: 100, outputTokens: 3 })
  })

  it('talks to OpenRouter with usage accounting on', async () => {
    const { client, requests } = fakeOpenAI([{ choices: [{ delta: { content: '{"thought":"hi","tool":"say","args":{"message":"yo"}}' } }] }])
    const provider = new OpenAIProvider({ baseURL: OPENROUTER_URL, model: 'a/b', apiKey: 'k', label: 'openrouter', extraBody: { usage: { include: true } }, client })
    expect(provider.name).toBe('openrouter a/b')
    await provider.decide(request)
    expect(requests[0]).toMatchObject({ model: 'a/b', usage: { include: true }, max_tokens: 16_000 })
    expect(createProvider({ provider: 'openrouter', model: 'a/b', apiKey: 'k' }).name).toBe('openrouter a/b')
  })

  it('caps the reply under the name OpenAI itself expects', async () => {
    const { client, requests } = fakeOpenAI([{ choices: [{ delta: { content: '{"tool":"say","args":{}}' } }] }])
    await new OpenAIProvider({ baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini', client }).decide(request)
    expect(requests[0]).toMatchObject({ max_completion_tokens: 16_000 })
    expect(requests[0]).not.toHaveProperty('max_tokens')
  })

  it('treats an OpenRouter bad request as fatal, but not a prompt that is too long', async () => {
    const failing = (message: string) =>
      ({
        chat: { completions: { create: async () => Promise.reject(new OpenAI.BadRequestError(400, { message }, message, new Headers())) } },
      }) as unknown as Pick<OpenAI, 'chat'>
    const openrouter = (message: string) =>
      new OpenAIProvider({ baseURL: OPENROUTER_URL, model: 'x/typo', label: 'openrouter', client: failing(message) }).decide(request)
    await expect(openrouter('x/typo is not a valid model ID')).rejects.toThrow(FatalLLMError)
    await expect(openrouter('This endpoint maximum context length is 8192 tokens')).rejects.not.toThrow(FatalLLMError)
    const local = new OpenAIProvider({ baseURL: 'http://x/v1', model: 'm', client: failing('bad') }).decide(request)
    await expect(local).rejects.not.toThrow(FatalLLMError)
  })

  it('falls back to a decision written as text', async () => {
    const { client } = fakeOpenAI([{ choices: [{ delta: { content: '{"thought":"hi","tool":"say","args":{"message":"yo"}}' } }] }])
    expect(await new OpenAIProvider({ baseURL: 'http://x', model: 'm', client }).decide(request)).toEqual({ thought: 'hi', tool: 'say', args: { message: 'yo' } })
  })
})

function fakeAnthropic(events: unknown[], final: unknown) {
  const requests: Record<string, unknown>[] = []
  const client = {
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          requests.push(body)
          return {
            async *[Symbol.asyncIterator]() {
              yield* events
            },
            finalMessage: async () => final,
          }
        },
      },
    },
  } as unknown as Pick<Anthropic, 'beta'>
  return { client, requests }
}

describe('AnthropicProvider', () => {
  it('streams thinking and returns the tool call', async () => {
    const { client, requests } = fakeAnthropic(
      [
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a player spoke' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"message":"hi"}' } },
      ],
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'a player spoke\nmore' },
          { type: 'tool_use', id: 't1', name: 'say', input: { message: 'hi' } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 7 },
      },
    )
    const deltas: string[] = []
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', effort: 'medium', client })
    const decision = await provider.decide({ ...request, onStream: (d) => deltas.push(`${d.kind}:${d.text}`) })
    expect(decision).toEqual({
      thought: 'a player spoke',
      tool: 'say',
      args: { message: 'hi' },
      promptTokens: 100,
      usage: { inputTokens: 100, outputTokens: 7 },
    })
    expect(deltas).toEqual(['thinking:a player spoke', 'tool:{"message":"hi"}'])
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      fallbacks: 'default',
      tools: [{ name: 'say', eager_input_streaming: true }],
    })
  })

  it('treats refusals and cut-off tool calls as invalid replies', async () => {
    const refused = fakeAnthropic([], { stop_reason: 'refusal', content: [] })
    await expect(new AnthropicProvider({ model: 'm', effort: 'low', client: refused.client }).decide(request)).rejects.toThrow(LLMFormatError)
    const cut = fakeAnthropic([], { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'say', input: {} }] })
    await expect(new AnthropicProvider({ model: 'm', effort: 'low', client: cut.client }).decide(request)).rejects.toThrow(/cut off/)
  })
})

/** A client whose stream calls answer with `finals` in order; an Error entry makes that call fail. */
function scriptedAnthropic(finals: unknown[]) {
  const requests: Record<string, unknown>[] = []
  const client = {
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          requests.push(body)
          const final = finals.shift()
          return {
            async *[Symbol.asyncIterator]() {
              if (final instanceof Error) throw final
            },
            finalMessage: async () => final,
          }
        },
      },
    },
  } as unknown as Pick<Anthropic, 'beta'>
  return { client, requests }
}

const toolTurn = (id: string, message: string) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: `plan ${id}`, signature: `sig-${id}` },
    { type: 'tool_use', id, name: 'say', input: { message } },
  ],
  usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
})

describe('AnthropicProvider conversations', () => {
  it('sends earlier turns back unchanged, with the tool result and the new update', async () => {
    const { client, requests } = scriptedAnthropic([toolTurn('t1', 'hi'), toolTurn('t2', 'bye')])
    const conversation = new AnthropicProvider({ model: 'claude-opus-5-5', effort: 'high', client }).startConversation({ system: 'SYS', tools })
    expect(await conversation.next({ user: 'FULL PROMPT' })).toMatchObject({ tool: 'say', args: { message: 'hi' } })
    expect(conversation.contextTokens).toBe(100)
    expect(await conversation.next({ user: 'UPDATE', result: { outcome: 'ok: sent', isError: false } })).toMatchObject({ args: { message: 'bye' } })

    expect(requests[1]).toMatchObject({ cache_control: { type: 'ephemeral' }, output_config: { effort: 'high' } })
    expect(requests[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'FULL PROMPT' }] },
      { role: 'assistant', content: toolTurn('t1', 'hi').content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok: sent', is_error: false },
          { type: 'text', text: 'UPDATE' },
        ],
      },
    ])
  })

  it('keeps a reply without a tool call in the conversation, so the model can correct itself', async () => {
    const textOnly = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hmm' }] }
    const { client, requests } = scriptedAnthropic([textOnly, toolTurn('t1', 'ok')])
    const conversation = new AnthropicProvider({ model: 'm', effort: 'high', client }).startConversation({ system: 'SYS', tools })
    await expect(conversation.next({ user: 'FULL' })).rejects.toThrow(LLMFormatError)
    expect(conversation.closed).toBe(false)
    await conversation.next({ user: 'reply with a tool call' })
    expect(requests[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'FULL' }] },
      { role: 'assistant', content: textOnly.content },
      { role: 'user', content: [{ type: 'text', text: 'reply with a tool call' }] },
    ])
  })

  it('does not keep a turn whose request failed', async () => {
    const { client, requests } = scriptedAnthropic([toolTurn('t1', 'a'), new Error('socket hang up'), toolTurn('t2', 'b')])
    const conversation = new AnthropicProvider({ model: 'm', effort: 'high', client }).startConversation({ system: 'SYS', tools })
    await conversation.next({ user: 'FULL' })
    const result = { outcome: 'ok: sent', isError: false }
    await expect(conversation.next({ user: 'U1', result })).rejects.toThrow()
    await conversation.next({ user: 'U2', result })
    expect(requests[2]!.messages).toHaveLength(3)
    expect((requests[2]!.messages as { content: { text?: string }[] }[])[2]!.content[1]).toEqual({ type: 'text', text: 'U2' })
  })

  it('closes after a refusal or a cut-off tool call', async () => {
    const refused = scriptedAnthropic([{ stop_reason: 'refusal', content: [] }])
    const a = new AnthropicProvider({ model: 'm', effort: 'high', client: refused.client }).startConversation({ system: 'SYS', tools })
    await expect(a.next({ user: 'FULL' })).rejects.toThrow(LLMFormatError)
    expect(a.closed).toBe(true)
    const cut = scriptedAnthropic([{ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'say', input: {} }] }])
    const b = new AnthropicProvider({ model: 'm', effort: 'high', client: cut.client }).startConversation({ system: 'SYS', tools })
    await expect(b.next({ user: 'FULL' })).rejects.toThrow(/cut off/)
    expect(b.closed).toBe(true)
  })
})

describe('SwitchableProvider', () => {
  const named = (name: string): LLMProvider => ({ name, decide: async () => ({ thought: name, tool: 'say', args: {} }) })

  it('delegates to the current provider and wakes waiters on change', async () => {
    const switchable = new SwitchableProvider(named('a'), { provider: 'ollama', model: 'a' })
    expect((await switchable.decide(request)).thought).toBe('a')
    const changed = switchable.changed()
    switchable.set(named('b'), { provider: 'ollama', model: 'b' })
    await changed
    expect(switchable.name).toBe('b')
    expect((await switchable.decide(request)).thought).toBe('b')
  })

  const label = { provider: 'openrouter', model: 'a/b' } as const
  const recording = (provider: LLMProvider, start = label) => {
    const records: CallRecord[] = []
    return { records, switchable: new SwitchableProvider(provider, start, (r) => records.push(r)) }
  }
  const replying = (reply: () => Promise<Decision>): LLMProvider => ({ name: 'p', decide: reply })

  it('records each call with its label, usage and duration', async () => {
    const { records, switchable } = recording(replying(async () => ({ thought: '', tool: 'say', args: {}, usage: { inputTokens: 5 } })))
    await switchable.decide(request)
    expect(records).toEqual([{ ...label, kind: 'decision', usage: { inputTokens: 5 }, durationMs: expect.any(Number) }])
    expect(switchable.label).toEqual(label)
    expect(labelOf({ provider: 'anthropic', model: 'm', effort: 'high', apiKey: 'k' })).toEqual({ provider: 'anthropic', model: 'm' })
  })

  it('records failed calls and rethrows, keeping the usage of a format error', async () => {
    const fatal = recording(replying(async () => Promise.reject(new FatalLLMError('no tools'))))
    await expect(fatal.switchable.decide(request)).rejects.toThrow(FatalLLMError)
    expect(fatal.records[0]).toMatchObject({ kind: 'decision', error: 'no tools', usage: {} })
    const format = recording(replying(async () => Promise.reject(new LLMFormatError('bad', { inputTokens: 9 }))))
    await expect(format.switchable.decide(request)).rejects.toThrow(LLMFormatError)
    expect(format.records[0]).toMatchObject({ error: 'bad', usage: { inputTokens: 9 } })
  })

  it('records an in-flight call under the model that started it', async () => {
    let finish: (d: Decision) => void = () => {}
    const slow = replying(() => new Promise<Decision>((resolve) => (finish = resolve)))
    const { records, switchable } = recording(slow)
    const pending = switchable.decide(request)
    switchable.set(named('b'), { provider: 'ollama', model: 'b' })
    finish({ thought: '', tool: 'say', args: {} })
    await pending
    expect(records[0]).toMatchObject(label)
  })

  it('records reflection calls and conversation turns', async () => {
    const conversation: Conversation = { next: async () => ({ thought: '', tool: 'say', args: {} }), contextTokens: 42, closed: false }
    const provider: LLMProvider = { ...named('a'), startConversation: () => conversation }
    const { records, switchable } = recording(provider)
    await switchable.decide({ ...request, purpose: 'reflection' })
    const wrapped = switchable.startConversation!({ system: 'SYS', tools })
    await wrapped.next({ user: 'U' })
    expect(wrapped.contextTokens).toBe(42)
    expect(wrapped.closed).toBe(false)
    expect(records.map((r) => r.kind)).toEqual(['reflection', 'decision'])
  })
})
