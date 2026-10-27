import type { ToolSpec } from '../tools/types.ts'
import type { Decision } from './types.ts'

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

/** A decision written as text: a JSON object, or a call like `mine(block_type='oak_log', count=3)`. */
export function parseDecisionText(text: string, names: string[]): Decision | null {
  return parseJsonDecision(text, names) ?? parseCallText(text, names)
}

function parseJsonDecision(text: string, names: string[]): Decision | null {
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

/**
 * Gemini models often write the call as Python instead of using the tool-call channel, e.g.
 * `tool_code\nprint(default_api.mine(block_type='oak_log', count=3))`. Reads the first call of a known tool, with
 * keyword arguments or one object argument.
 */
function parseCallText(text: string, names: string[]): Decision | null {
  for (const match of text.matchAll(/(?<![\w.])(?:default_api\.)?(\w+)\(/g)) {
    const tool = match[1] as string
    if (!names.includes(tool)) continue
    try {
      const reader = new LiteralReader(text, match.index + match[0].length)
      return { thought: '', tool, args: reader.callArgs() }
    } catch {
      return null
    }
  }
  return null
}

/** Reads Python (or JSON) literals: strings, numbers, True/False/None, lists and dicts. Throws on anything else. */
class LiteralReader {
  #pos: number

  constructor(
    readonly text: string,
    start: number,
  ) {
    this.#pos = start
  }

  /** `key=value, …)` or `{…})`, up to and including the closing parenthesis. */
  callArgs(): Record<string, unknown> {
    this.#space()
    if (this.text[this.#pos] === '{') {
      const value = this.#value() as Record<string, unknown>
      this.#expect(')')
      return value
    }
    const args: Record<string, unknown> = {}
    this.#list(')', () => {
      this.#space()
      const key = /^\w+/.exec(this.text.slice(this.#pos))?.[0]
      if (!key) throw new Error('expected an argument name')
      this.#pos += key.length
      this.#expect('=')
      args[key] = this.#value()
    })
    return args
  }

  #value(): unknown {
    this.#space()
    const c = this.text[this.#pos]
    if (c === '"' || c === "'") return this.#string(c)
    if (c === '[') {
      this.#pos++
      const items: unknown[] = []
      this.#list(']', () => items.push(this.#value()))
      return items
    }
    if (c === '{') {
      this.#pos++
      const entries: [string, unknown][] = []
      this.#list('}', () => {
        const key = this.#value()
        if (typeof key !== 'string') throw new Error('dict keys must be strings')
        this.#expect(':')
        entries.push([key, this.#value()])
      })
      return Object.fromEntries(entries)
    }
    const word = /^(?:-?\d+(?:\.\d+)?(?:e-?\d+)?|True|False|None|true|false|null)/.exec(this.text.slice(this.#pos))?.[0]
    if (!word) throw new Error(`unexpected ${c ?? 'end of text'}`)
    this.#pos += word.length
    if (word === 'True' || word === 'true') return true
    if (word === 'False' || word === 'false') return false
    if (word === 'None' || word === 'null') return null
    return Number(word)
  }

  #string(quote: string): string {
    let out = ''
    for (let i = this.#pos + 1; i < this.text.length; i++) {
      const c = this.text[i] as string
      if (c === quote) {
        this.#pos = i + 1
        return out
      }
      if (c === '\\') {
        const next = this.text[++i] ?? ''
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      } else out += c
    }
    throw new Error('unterminated string')
  }

  /** Reads comma-separated items up to and including `close` (a trailing comma is fine). */
  #list(close: string, item: () => void): void {
    while (!this.#eat(close)) {
      item()
      if (this.#eat(',')) continue
      this.#expect(close)
      return
    }
  }

  #eat(c: string): boolean {
    this.#space()
    if (this.text[this.#pos] !== c) return false
    this.#pos++
    return true
  }

  #expect(c: string): void {
    if (!this.#eat(c)) throw new Error(`expected ${c}`)
  }

  #space(): void {
    while (/\s/.test(this.text[this.#pos] ?? '')) this.#pos++
  }
}

export function toArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
