import { Ollama, type Message, type Tool as OllamaTool } from 'ollama'
import { truncate } from '../lib/text.ts'
import type { ToolSpec } from '../tools/types.ts'
import { FatalLLMError, LLMFormatError, type DecideRequest, type Decision, type LLMProvider } from './types.ts'

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

const JSON_INSTRUCTIONS =
  'Reply with a JSON object: {"thought": "<one short sentence>", "tool": "<tool name>", "args": {<arguments>}}.'

export class OllamaProvider implements LLMProvider {
  readonly name: string
  readonly #options: OllamaOptions
  readonly #client: Pick<Ollama, 'chat'>

  constructor(options: OllamaOptions) {
    this.#options = options
    this.#client = options.client ?? new Ollama({ host: options.host })
    this.name = `ollama ${options.model} (${options.mode})`
  }

  async decide(request: DecideRequest): Promise<Decision> {
    try {
      return await this.#decide(request)
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not support tools')) {
        throw new FatalLLMError(`${this.#options.model} does not support tool calling — set OLLAMA_MODE=json`)
      }
      throw err
    }
  }

  async #decide({ system, user, tools }: DecideRequest): Promise<Decision> {
    const { model, mode, think, temperature = 0.4, numCtx } = this.#options
    const names = tools.map((t) => t.name)
    const base = { model, stream: false as const, options: { temperature, ...(numCtx !== undefined && { num_ctx: numCtx }) }, ...(think !== undefined && { think }) }

    if (mode === 'tools') {
      const response = await this.#client.chat({
        ...base,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: tools.map(toOllamaTool),
      })
      return parseToolReply(response.message, names)
    }

    const response = await this.#client.chat({
      ...base,
      messages: [
        { role: 'system', content: `${system}\n\nTools:\n${describeTools(tools)}\n\n${JSON_INSTRUCTIONS}` },
        { role: 'user', content: user },
      ],
      format: decisionSchema(names),
    })
    const decision = parseDecisionText(response.message.content, names)
    if (!decision) throw new LLMFormatError(`reply is not a valid decision: "${truncate(response.message.content, 160)}"`)
    return decision
  }
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

/** One line per tool, e.g. `- mine(block_type: string, count?: integer) — Mine blocks`. */
export function describeTools(tools: ToolSpec[]): string {
  return tools
    .map(({ name, description, parameters }) => {
      const properties = (parameters.properties ?? {}) as Record<string, { type?: string }>
      const required = new Set((parameters.required ?? []) as string[])
      const params = Object.entries(properties).map(([key, p]) => `${key}${required.has(key) ? '' : '?'}: ${p.type ?? 'any'}`)
      return `- ${name}(${params.join(', ')}) — ${description}`
    })
    .join('\n')
}

function parseToolReply(message: Message, names: string[]): Decision {
  const call = message.tool_calls?.[0]
  if (call) {
    const thought = message.content.trim() || truncate(message.thinking?.trim().split('\n')[0] ?? '', 160)
    return { thought, tool: call.function.name, args: toArgs(call.function.arguments) }
  }
  // Some models write the call as JSON text instead of using the tool-call channel.
  const fromText = parseDecisionText(message.content, names)
  if (fromText) return fromText
  throw new LLMFormatError(`no tool call in reply: "${truncate(message.content, 160)}"`)
}

export function parseDecisionText(text: string, names: string[]): Decision | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const tool = obj.tool ?? obj.name
  if (typeof tool !== 'string' || !names.includes(tool)) return null
  return { thought: typeof obj.thought === 'string' ? obj.thought : '', tool, args: toArgs(obj.args ?? obj.arguments) }
}

function toArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
