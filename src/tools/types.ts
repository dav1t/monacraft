import type { Bot } from 'mineflayer'
import type { z } from 'zod'
import type { Repos } from '../db/repos.ts'

export interface BaseContext {
  bot: Bot
  repos: Repos
  signal: AbortSignal
  log: (message: string) => void
}

export interface ToolContext extends BaseContext {
  /** Run another registered tool with the same context (used by skills). */
  call: (tool: string, args: unknown) => Promise<string>
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  /** Overrides the agent's default time limit for one action. */
  timeoutMs?: number
  run: (args: z.output<S>, ctx: ToolContext) => Promise<string>
}

/** What the LLM sees: name, description and JSON schema of the arguments. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A failure the LLM should read and react to (bad arguments, missing items, nothing found…). */
export class ToolError extends Error {
  override name = 'ToolError'
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool {
  return tool as unknown as Tool
}
