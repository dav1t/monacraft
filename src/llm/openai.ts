import OpenAI from 'openai'
import { errorMessage, truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { parseDecisionText, toArgs } from './parse.ts'
import { FatalLLMError, LLMFormatError, usageOf, type DecideRequest, type Decision, type LLMProvider, type Usage } from './types.ts'

export interface OpenAIOptions {
  /** Any OpenAI-compatible endpoint: OpenAI, OpenRouter, LM Studio, llama.cpp, Groq… */
  baseURL: string
  model: string
  apiKey?: string
  /** Names the provider in its name and errors (default "openai-compatible"). */
  label?: string
  /** Server-specific request fields, e.g. OpenRouter's usage accounting. */
  extraBody?: Record<string, unknown>
  client?: Pick<OpenAI, 'chat'>
}

/** Reasoning text sent by servers that expose it (DeepSeek, OpenRouter, LM Studio, llama.cpp). Not part of the OpenAI types. */
interface ReasoningDelta {
  reasoning_content?: string | null
  reasoning?: string | null
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string
  readonly #options: OpenAIOptions
  readonly #client: Pick<OpenAI, 'chat'>

  constructor(options: OpenAIOptions) {
    this.#options = options
    // Local servers ignore the key, but the SDK refuses to start without one. The agent retries failed steps itself,
    // with a growing pause; the SDK's own retries would resend the same request unseen.
    this.#client = options.client ?? new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey || 'not-needed', maxRetries: 0 })
    this.name = `${options.label ?? 'openai-compatible'} ${options.model}`
  }

  async decide({ system, user, tools, onStream, signal }: DecideRequest): Promise<Decision> {
    const names = tools.map((t) => t.name)
    let text = ''
    let reasoning = ''
    const calls: { name: string; arguments: string }[] = []
    let promptTokens: number | undefined
    let usage: Usage | undefined
    try {
      const stream = await this.#client.chat.completions.create({
        ...this.#options.extraBody,
        model: this.#options.model,
        // A model stuck repeating itself would otherwise write until the server gives up. OpenAI's reasoning models only
        // accept the newer name; other servers know the older one.
        ...(isOpenAI(this.#options.baseURL) ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS }),
        stream: true,
        // The last chunk then reports token usage (servers that don't support it leave it out).
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: tools.map(toOpenAITool),
        tool_choice: 'auto',
        parallel_tool_calls: false,
      }, { ...(signal && { signal }) })
      for await (const chunk of stream) {
        if (chunk.usage) {
          if (chunk.usage.prompt_tokens) promptTokens = chunk.usage.prompt_tokens
          // OpenRouter adds the request's cost to the usage it reports.
          const { prompt_tokens, completion_tokens, cost } = chunk.usage as OpenAI.CompletionUsage & { cost?: number }
          usage = usageOf({ inputTokens: prompt_tokens, outputTokens: completion_tokens, cost })
        }
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        const thinking = (delta as ReasoningDelta).reasoning_content ?? (delta as ReasoningDelta).reasoning
        if (thinking) {
          reasoning += thinking
          onStream?.({ kind: 'thinking', text: thinking })
        }
        if (delta.content) {
          text += delta.content
          onStream?.({ kind: 'text', text: delta.content })
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { name: '', arguments: '' })
          call.name += part.function?.name ?? ''
          call.arguments += part.function?.arguments ?? ''
          const piece = `${part.function?.name ? `${part.function.name} ` : ''}${part.function?.arguments ?? ''}`
          if (piece) onStream?.({ kind: 'tool', text: piece })
        }
      }
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError || err instanceof OpenAI.NotFoundError) {
        throw new FatalLLMError(`${this.#options.label ?? 'openai-compatible'}: ${errorMessage(err)}`)
      }
      // OpenRouter answers an unknown model or one without tool support with 400; retrying cannot help. A prompt that is
      // too long can shrink after a nap, so it stays retryable.
      if (this.#options.label === 'openrouter' && err instanceof OpenAI.BadRequestError && !/context|too long|tokens/i.test(err.message)) {
        throw new FatalLLMError(`openrouter: ${errorMessage(err)}`)
      }
      throw err
    }

    const counts = { ...(promptTokens && { promptTokens }), ...(usage && { usage }) }
    const call = calls.find((c) => c?.name)
    if (call) {
      if (!names.includes(call.name)) throw new LLMFormatError(`unknown tool "${call.name}"`, usage)
      let args: unknown
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        throw new LLMFormatError(`tool arguments are not valid JSON: ${truncate(call.arguments, 160)}`, usage)
      }
      const thought = text.trim() || truncate(reasoning.trim().split('\n')[0] ?? '', 160)
      return { thought, tool: call.name, args: toArgs(args), ...counts }
    }
    const fromText = parseDecisionText(text, names)
    if (fromText) return { ...fromText, ...counts }
    throw new LLMFormatError(`no tool call in reply: "${truncate(text, 160)}"`, usage)
  }
}

/** Room for reasoning plus one tool call. */
const MAX_OUTPUT_TOKENS = 16_000

function isOpenAI(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

function toOpenAITool(spec: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  return { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } }
}
