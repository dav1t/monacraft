import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allTools } from '../src/tools/index.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { defineTool, ToolError, type BaseContext } from '../src/tools/types.ts'

const echo = defineTool({
  name: 'echo',
  description: 'Echo text a number of times',
  schema: z.object({ text: z.string(), times: z.number().int().min(1).default(1) }),
  run: async ({ text, times }) => text.repeat(times),
})

const ctx = { signal: new AbortController().signal } as BaseContext

describe('ToolRegistry', () => {
  it('runs a tool with validated, defaulted arguments', async () => {
    const registry = new ToolRegistry().register(echo)
    expect(await registry.run('echo', { text: 'ab' }, ctx)).toBe('ab')
    expect(await registry.run('echo', { text: 'ab', times: 2 }, ctx)).toBe('abab')
  })

  it('reports unknown tools and invalid arguments as ToolError', async () => {
    const registry = new ToolRegistry().register(echo)
    await expect(registry.run('fly', {}, ctx)).rejects.toThrow(ToolError)
    await expect(registry.run('echo', { times: 2 }, ctx)).rejects.toThrow(/invalid arguments for echo/)
  })

  it('does not start a tool when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const registry = new ToolRegistry().register(echo)
    await expect(registry.run('echo', { text: 'x' }, { ...ctx, signal: controller.signal })).rejects.toThrow('stop')
  })

  it('lets a tool call other tools through ctx.call', async () => {
    const twice = defineTool({
      name: 'twice',
      description: '',
      schema: z.object({}),
      run: async (_args, { call }) => call('echo', { text: 'hi', times: 2 }),
    })
    expect(await new ToolRegistry().register(echo, twice).run('twice', {}, ctx)).toBe('hihi')
  })

  it('describes tools as JSON schema where defaulted arguments are optional', () => {
    const [spec] = new ToolRegistry().register(echo).specs()
    expect(spec).toMatchObject({
      name: 'echo',
      description: 'Echo text a number of times',
      parameters: { type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer' } }, required: ['text'] },
    })
    expect(spec?.parameters).not.toHaveProperty('$schema')
  })

  it('refuses duplicate names', () => {
    expect(() => new ToolRegistry().register(echo, echo)).toThrow(/duplicate tool/)
  })

  it('registers every game tool with a valid JSON schema', () => {
    const specs = new ToolRegistry().register(...allTools).specs()
    expect(specs).toHaveLength(36)
    for (const spec of specs) expect(spec.parameters).toMatchObject({ type: 'object' })
  })
})
