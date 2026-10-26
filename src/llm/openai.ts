import OpenAI from 'openai'
import { errorMessage, truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { parseDecisionText, toArgs } from './parse.ts'
import { FatalLLMError, LLMFormatError, type DecideRequest, type Decision, type LLMProvider } from './types.ts'

export interface OpenAIOptions {
  /** Any OpenAI-compatible endpoint: OpenAI, OpenRouter, LM Studio, llama.cpp, Groq… */
  baseURL: string
  model: string
  apiKey?: string
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
    // Local servers ignore the key, but the SDK refuses to start without one.
    this.#client = options.client ?? new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey || 'not-needed' })
    this.name = `openai-compatible ${options.model}`
  }

  async decide({ system, user, tools, onStream }: DecideRequest): Promise<Decision> {
    const names = tools.map((t) => t.name)
    let text = ''
    let reasoning = ''
    const calls: { name: string; arguments: string }[] = []
    let promptTokens: number | undefined
    try {
      const stream = await this.#client.chat.completions.create({
        model: this.#options.model,
        stream: true,
        // The last chunk then reports token usage (servers that don't support it leave it out).
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: tools.map(toOpenAITool),
        tool_choice: 'auto',
        parallel_tool_calls: false,
      })
      for await (const chunk of stream) {
        if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens
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
        throw new FatalLLMError(`openai-compatible: ${errorMessage(err)}`)
      }
      throw err
    }

    const call = calls.find((c) => c?.name)
    if (call) {
      if (!names.includes(call.name)) throw new LLMFormatError(`unknown tool "${call.name}"`)
      let args: unknown
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        throw new LLMFormatError(`tool arguments are not valid JSON: ${truncate(call.arguments, 160)}`)
      }
      const thought = text.trim() || truncate(reasoning.trim().split('\n')[0] ?? '', 160)
      return { thought, tool: call.name, args: toArgs(args), ...(promptTokens && { promptTokens }) }
    }
    const fromText = parseDecisionText(text, names)
    if (fromText) return { ...fromText, ...(promptTokens && { promptTokens }) }
    throw new LLMFormatError(`no tool call in reply: "${truncate(text, 160)}"`)
  }
}

function toOpenAITool(spec: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  return { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } }
}
