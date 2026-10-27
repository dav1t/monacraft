import { Ollama, type ChatRequest, type Message, type Tool as OllamaTool } from 'ollama'
import { truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { describeTools, parseDecisionText, toArgs } from './parse.ts'
import { FatalLLMError, LLMFormatError, usageOf, type DecideRequest, type Decision, type LLMProvider, type Usage } from './types.ts'

export type OllamaMode = 'tools' | 'json'
export type ThinkSetting = boolean | 'low' | 'medium' | 'high'

export interface OllamaOptions {
  model: string
  /** `tools`: native tool calling. `json`: schema-constrained JSON, works with models without tool support. */
  mode: OllamaMode
  host?: string
  think?: ThinkSetting
  temperature?: number
  /** Context window in tokens. Ollama's default (4096) truncates our prompts. */
  numCtx?: number
  client?: Pick<Ollama, 'chat'>
}

/** How long Ollama keeps the model in memory after a request. */
const KEEP_ALIVE = '30m'

const JSON_INSTRUCTIONS =
  'Reply with a JSON object: {"thought": "<one short sentence>", "tool": "<tool name>", "args": {<arguments>}}.'

export class OllamaProvider implements LLMProvider {
  readonly name: string
  readonly contextWindow: number | undefined
  readonly #options: OllamaOptions
  readonly #client: Pick<Ollama, 'chat'>

  constructor(options: OllamaOptions) {
    this.#options = options
    this.#client = options.client ?? new Ollama({ host: options.host })
    this.name = `ollama ${options.model} (${options.mode})`
    this.contextWindow = options.numCtx
  }

  async decide(request: DecideRequest): Promise<Decision> {
    try {
      return await this.#decide(request)
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not support tools')) {
        throw new FatalLLMError(`${this.#options.model} does not support tool calling — switch the Ollama mode to json (OLLAMA_MODE=json)`)
      }
      throw err
    }
  }

  async #decide({ system, user, tools, onStream, signal }: DecideRequest): Promise<Decision> {
    const { model, mode, think, temperature = 0.4, numCtx } = this.#options
    const names = tools.map((t) => t.name)
    const base = {
      model,
      // Ollama unloads an idle model after 5 minutes; reloading it stalls the first step after a nap or a pause.
      keep_alive: KEEP_ALIVE,
      options: { temperature, ...(numCtx !== undefined && { num_ctx: numCtx }) },
      ...(think !== undefined && { think }),
    }

    if (mode === 'tools') {
      const { message, usage } = await this.#chat(
        { ...base, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: tools.map(toOllamaTool) },
        onStream,
        signal,
      )
      return { ...parseToolReply(message, names, usage), ...counts(usage) }
    }

    const { message, usage } = await this.#chat(
      {
        ...base,
        messages: [
          { role: 'system', content: `${system}

Tools:
${describeTools(tools)}

${JSON_INSTRUCTIONS}` },
          { role: 'user', content: user },
        ],
        format: decisionSchema(names),
      },
      onStream,
      signal,
    )
    const decision = parseDecisionText(message.content, names)
    if (!decision) throw new LLMFormatError(`reply is not a valid decision: "${truncate(message.content, 160)}"`, usage)
    return { ...decision, ...counts(usage) }
  }

  /**
   * One chat request; streamed (and reported piece by piece) only when someone listens. Only a stream can be cancelled;
   * a cancelled plain request is waited out and its reply dropped.
   */
  async #chat(
    request: Omit<ChatRequest, 'stream'>,
    onStream: DecideRequest['onStream'],
    signal: AbortSignal | undefined,
  ): Promise<{ message: Message; usage?: Usage }> {
    if (!onStream) {
      const response = await this.#client.chat({ ...request, stream: false })
      signal?.throwIfAborted()
      const usage = usageOf({ inputTokens: response.prompt_eval_count, outputTokens: response.eval_count })
      return { message: response.message, ...(usage && { usage }) }
    }
    const message: Message = { role: 'assistant', content: '', thinking: '', tool_calls: [] }
    let usage: Usage | undefined
    const stream = await this.#client.chat({ ...request, stream: true })
    const abort = () => stream.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      for await (const part of stream) {
        // The final part carries the counts (the whole prompt, even when Ollama reused its cache).
        if (part.prompt_eval_count) usage = usageOf({ inputTokens: part.prompt_eval_count, outputTokens: part.eval_count })
        const { content, thinking, tool_calls } = part.message
        if (thinking) {
          message.thinking += thinking
          onStream({ kind: 'thinking', text: thinking })
        }
        if (content) {
          message.content += content
          onStream({ kind: 'text', text: content })
        }
        for (const call of tool_calls ?? []) {
          message.tool_calls?.push(call)
          onStream({ kind: 'tool', text: `${call.function.name} ${JSON.stringify(call.function.arguments)}` })
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    return { message, ...(usage && { usage }) }
  }
}

function counts(usage: Usage | undefined): Pick<Decision, 'promptTokens' | 'usage'> {
  return { ...(usage?.inputTokens && { promptTokens: usage.inputTokens }), ...(usage && { usage }) }
}

function toOllamaTool(spec: ToolSpec): OllamaTool {
  return {
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.parameters as OllamaTool['function']['parameters'] },
  }
}

function decisionSchema(names: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: { thought: { type: 'string' }, tool: { type: 'string', enum: names }, args: { type: 'object' } },
    required: ['thought', 'tool', 'args'],
  }
}

function parseToolReply(message: Message, names: string[], usage: Usage | undefined): Decision {
  const call = message.tool_calls?.[0]
  if (call) {
    const thought = message.content.trim() || truncate(message.thinking?.trim().split('\n')[0] ?? '', 160)
    return { thought, tool: call.function.name, args: toArgs(call.function.arguments) }
  }
  // Some models write the call as JSON text instead of using the tool-call channel.
  const fromText = parseDecisionText(message.content, names)
  if (fromText) return fromText
  throw new LLMFormatError(`no tool call in reply: "${truncate(message.content, 160)}"`, usage)
}
