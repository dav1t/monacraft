import Anthropic from '@anthropic-ai/sdk'
import { errorMessage, truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { parseDecisionText, toArgs } from './parse.ts'
import { FatalLLMError, LLMFormatError, type DecideRequest, type Decision, type LLMProvider } from './types.ts'

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthropicOptions {
  model: string
  effort: AnthropicEffort
  /** Falls back to the SDK's own lookup (ANTHROPIC_API_KEY, `ant auth login` profile). */
  apiKey?: string
  client?: Pick<Anthropic, 'beta'>
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
    const names = tools.map((t) => t.name)
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
      tools: tools.map(toAnthropicTool),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: user }],
    })

    let message: Anthropic.Beta.BetaMessage
    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta' || !onStream) continue
        const { delta } = event
        if (delta.type === 'thinking_delta') onStream({ kind: 'thinking', text: delta.thinking })
        else if (delta.type === 'text_delta') onStream({ kind: 'text', text: delta.text })
        else if (delta.type === 'input_json_delta') onStream({ kind: 'tool', text: delta.partial_json })
      }
      message = await stream.finalMessage()
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
        throw new FatalLLMError(`anthropic: ${errorMessage(err)}`)
      }
      if (err instanceof Anthropic.APIError) throw err
      // The SDK could not parse a streamed tool input.
      throw new LLMFormatError(`tool input was not valid JSON (${errorMessage(err)})`)
    }

    if (message.stop_reason === 'refusal') throw new LLMFormatError('the model declined this request')
    const call = message.content.find((block) => block.type === 'tool_use')
    if (call && message.stop_reason === 'max_tokens') throw new LLMFormatError('the reply was cut off mid tool call')
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim()
    if (call) {
      const thinking = message.content.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : [])).join(' ')
      return { thought: text || truncate(thinking.trim().split('\n')[0] ?? '', 160), tool: call.name, args: toArgs(call.input) }
    }
    const fromText = parseDecisionText(text, names)
    if (fromText) return fromText
    throw new LLMFormatError(`no tool call in reply: "${truncate(text, 160)}"`)
  }
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
