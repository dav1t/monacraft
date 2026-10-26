import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../src/llm/anthropic.ts'
import { OpenAIProvider } from '../src/llm/openai.ts'
import { SwitchableProvider } from '../src/llm/providers.ts'
import { LLMFormatError, type LLMProvider } from '../src/llm/types.ts'
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
      },
    )
    const deltas: string[] = []
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', effort: 'medium', client })
    const decision = await provider.decide({ ...request, onStream: (d) => deltas.push(`${d.kind}:${d.text}`) })
    expect(decision).toEqual({ thought: 'a player spoke', tool: 'say', args: { message: 'hi' } })
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
    const switchable = new SwitchableProvider(named('a'))
    expect((await switchable.decide(request)).thought).toBe('a')
    const changed = switchable.changed()
    switchable.set(named('b'))
    await changed
    expect(switchable.name).toBe('b')
    expect((await switchable.decide(request)).thought).toBe('b')
  })
})
