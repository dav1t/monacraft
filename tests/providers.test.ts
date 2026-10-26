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
