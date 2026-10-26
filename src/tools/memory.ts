import { z } from 'zod'
import { defineTool, ToolError } from './types.ts'

export const remember = defineTool({
  name: 'remember',
  description: 'Store a fact for later (survives restarts), e.g. key "base", value "120 64 -44".',
  schema: z.object({ key: z.string().min(1), value: z.string().min(1) }),
  run: async ({ key, value }, { repos }) => {
    repos.memory.set(key, value)
    return `remembered ${key}`
  },
})

export const forget = defineTool({
  name: 'forget',
  description: 'Delete a remembered fact that is no longer true.',
  schema: z.object({ key: z.string().min(1) }),
  run: async ({ key }, { repos }) => {
    if (!repos.memory.delete(key)) throw new ToolError(`nothing remembered under ${key}`)
    return `forgot ${key}`
  },
})
