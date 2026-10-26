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
