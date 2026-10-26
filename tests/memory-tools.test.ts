import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { forget, remember, setGoal } from '../src/tools/memory.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

describe('memory tools', () => {
  it('remembers, forgets and sets the goal', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const registry = new ToolRegistry().register(remember, forget, setGoal)
    const ctx = { bot: {} as Bot, repos, log: () => {}, signal: new AbortController().signal }
    const run = (tool: string, args: unknown) => registry.run(tool, args, ctx)

    expect(await run('remember', { key: 'base', value: '10 64 -20' })).toBe('remembered base')
    expect(await run('set_goal', { goal: 'build a hut' })).toBe('goal set: build a hut')
    expect(repos.memory.all()).toEqual({ base: '10 64 -20', goal: 'build a hut' })
    expect(await run('forget', { key: 'base' })).toBe('forgot base')
    await expect(run('forget', { key: 'base' })).rejects.toThrow(/nothing remembered/)
  })
})
