import { z } from 'zod'
import { ToolError, type BaseContext, type Tool, type ToolSpec } from './types.ts'

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()

  register(...tools: Tool[]): this {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      this.#tools.set(tool.name, tool)
    }
    return this
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  specs(): ToolSpec[] {
    return [...this.#tools.values()].map((tool) => {
      const { $schema: _, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>
      return { name: tool.name, description: tool.description, parameters }
    })
  }

  async run(name: string, args: unknown, ctx: BaseContext): Promise<string> {
    const tool = this.#tools.get(name)
    if (!tool) throw new ToolError(`unknown tool "${name}"`)
    const parsed = tool.schema.safeParse(args ?? {})
    if (!parsed.success) throw new ToolError(`invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`)
    ctx.signal.throwIfAborted()
    return tool.run(parsed.data, { ...ctx, call: (next, nextArgs) => this.run(next, nextArgs, ctx) })
  }
}
