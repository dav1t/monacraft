import Anthropic from '@anthropic-ai/sdk'
import { errorMessage, truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { parseDecisionText, toArgs } from './parse.ts'
import {
  FatalLLMError,
  LLMFormatError,
  type Conversation,
  type ConverseRequest,
  type DecideRequest,
  type Decision,
  type LLMProvider,
  type StreamDelta,
} from './types.ts'

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthropicOptions {
  model: string
  effort: AnthropicEffort
  /** Falls back to the SDK's own lookup (ANTHROPIC_API_KEY, `ant auth login` profile). */
  apiKey?: string
  client?: Pick<Anthropic, 'beta'>
}

interface Setup {
  system: string
  tools: ToolSpec[]
}

export class AnthropicProvider implements LLMProvider {
  readonly name: string
  readonly #options: AnthropicOptions
  readonly #client: Pick<Anthropic, 'beta'>

  constructor(options: AnthropicOptions) {
    this.#options = options
    this.#client = options.client ?? new Anthropic({ ...(options.apiKey && { apiKey: options.apiKey }) })
    this.name = `anthropic ${options.model} (${options.effort})`
  }

  async decide({ system, user, tools, onStream }: DecideRequest): Promise<Decision> {
    const message = await this.send({ system, tools }, [{ role: 'user', content: user }], onStream, false)
    rejectBroken(message)
    return toDecision(message, tools)
  }

  readonly startConversation = (setup: Setup): Conversation => new AnthropicConversation(this, setup)

  /** One streamed request. `cacheHistory` caches the conversation so far, so the next turn only pays for what is new. */
  async send(
    { system, tools }: Setup,
    messages: Anthropic.Beta.BetaMessageParam[],
    onStream: ((delta: StreamDelta) => void) | undefined,
    cacheHistory: boolean,
  ): Promise<Anthropic.Beta.BetaMessage> {
    const stream = this.#client.beta.messages.stream({
      model: this.#options.model,
      max_tokens: 16000,
      // On a policy decline the API re-runs the request on a fallback model instead of stopping.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: this.#options.effort },
      // Tools and system prompt never change between steps, so they are cached together.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      ...(cacheHistory && { cache_control: { type: 'ephemeral' } }),
      tools: tools.map(toAnthropicTool),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages,
    })

    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta' || !onStream) continue
        const { delta } = event
        if (delta.type === 'thinking_delta') onStream({ kind: 'thinking', text: delta.thinking })
        else if (delta.type === 'text_delta') onStream({ kind: 'text', text: delta.text })
        else if (delta.type === 'input_json_delta') onStream({ kind: 'tool', text: delta.partial_json })
      }
      return await stream.finalMessage()
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
        throw new FatalLLMError(`anthropic: ${errorMessage(err)}`)
      }
      if (err instanceof Anthropic.APIError) throw err
      // The SDK could not parse a streamed tool input.
      throw new LLMFormatError(`tool input was not valid JSON (${errorMessage(err)})`)
    }
  }
}

/**
 * Keeps every turn, thinking blocks included, and sends them back unchanged: the model continues its own line of
 * thought instead of starting over each step. Turns are only appended, never edited, so earlier thinking stays valid
 * and the cached prefix keeps matching.
 */
class AnthropicConversation implements Conversation {
  readonly #provider: AnthropicProvider
  readonly #setup: Setup
  #history: Anthropic.Beta.BetaMessageParam[] = []
  /** The tool call that still needs its result. */
  #pending: string | null = null
  contextTokens = 0
  closed = false

  constructor(provider: AnthropicProvider, setup: Setup) {
    this.#provider = provider
    this.#setup = setup
  }

  async next({ user, result, onStream }: ConverseRequest): Promise<Decision> {
    if (this.closed) throw new Error('this conversation is closed; start a new one')
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    if (result && this.#pending) {
      content.push({ type: 'tool_result', tool_use_id: this.#pending, content: result.outcome, is_error: result.isError })
    } else if (result) {
      content.push({ type: 'text', text: `Result of your last action: ${result.outcome}` })
    }
    content.push({ type: 'text', text: user })
    const messages: Anthropic.Beta.BetaMessageParam[] = [...this.#history, { role: 'user', content }]

    // A failed request keeps nothing, so the same turn can be sent again.
    const message = await this.#provider.send(this.#setup, messages, onStream, true)
    try {
      rejectBroken(message)
    } catch (err) {
      this.closed = true
      throw err
    }
    this.#history = [...messages, { role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] }]
    this.#pending = message.content.find((block) => block.type === 'tool_use')?.id ?? null
    const usage = message.usage as Anthropic.Beta.BetaUsage | undefined
    if (usage) this.contextTokens = readTokens(usage) + (usage.output_tokens ?? 0)
    return toDecision(message, this.#setup.tools)
  }
}

/** Replies that cannot be used or continued: a refusal, or a tool call cut off by max_tokens. */
function rejectBroken(message: Anthropic.Beta.BetaMessage): void {
  if (message.stop_reason === 'refusal') throw new LLMFormatError('the model declined this request')
  const call = message.content.find((block) => block.type === 'tool_use')
  if (call && message.stop_reason === 'max_tokens') throw new LLMFormatError('the reply was cut off mid tool call')
}

/** Cached and uncached input together: everything the model read. */
function readTokens(usage: Anthropic.Beta.BetaUsage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

function toDecision(message: Anthropic.Beta.BetaMessage, tools: ToolSpec[]): Decision {
  const call = message.content.find((block) => block.type === 'tool_use')
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim()
  const usage = message.usage as Anthropic.Beta.BetaUsage | undefined
  const tokens = usage && { promptTokens: readTokens(usage) }
  if (call) {
    const thinking = message.content.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : [])).join(' ')
    return { thought: text || truncate(thinking.trim().split('\n')[0] ?? '', 160), tool: call.name, args: toArgs(call.input), ...tokens }
  }
  const fromText = parseDecisionText(text, tools.map((t) => t.name))
  if (fromText) return { ...fromText, ...tokens }
  throw new LLMFormatError(`no tool call in reply: "${truncate(text, 160)}"`)
}

function toAnthropicTool(spec: ToolSpec): Anthropic.Beta.BetaTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters as Anthropic.Beta.BetaTool['input_schema'],
    // Arguments are validated by the tool registry before anything runs.
    eager_input_streaming: true,
  }
}
