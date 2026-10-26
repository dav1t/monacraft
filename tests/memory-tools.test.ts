import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { forget, remember } from '../src/tools/memory.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

describe('memory tools', () => {
  it('remembers and forgets', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const registry = new ToolRegistry().register(remember, forget)
    const ctx = { bot: {} as Bot, repos, log: () => {}, signal: new AbortController().signal }
    const run = (tool: string, args: unknown) => registry.run(tool, args, ctx)

    expect(await run('remember', { key: 'base', value: '10 64 -20' })).toBe('remembered base')
    expect(repos.memory.all()).toEqual({ base: '10 64 -20' })
    expect(await run('forget', { key: 'base' })).toBe('forgot base')
    await expect(run('forget', { key: 'base' })).rejects.toThrow(/nothing remembered/)
  })
})
