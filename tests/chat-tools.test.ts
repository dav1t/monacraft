import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { say } from '../src/tools/chat.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

describe('say', () => {
  it('refuses to repeat the same or nearly the same message', async () => {
    const sent: string[] = []
    const bot = { chat: (m: string) => sent.push(m) } as unknown as Bot
    const ctx = { bot, repos: createRepos(openDatabase(':memory:')), log: () => {}, signal: new AbortController().signal }
    const run = (message: string) => new ToolRegistry().register(say).run('say', { message }, ctx)

    await run("I'm back at the frozen river! Let's explore further to find resources and establish a base.")
    await expect(run("I'm back at the frozen river! Let's explore further to find resources and establish a base.")).rejects.toThrow(
      /already said that/,
    )
    await expect(run("I'm back at the forest! Let's explore further to find resources and establish a base.")).rejects.toThrow(/already said that/)
    await run('Found some trees, chopping now.')
    expect(sent).toHaveLength(2)
  })
})
