import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { createSkill, reviseSkill, runSkill } from '../src/skills/tools.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { defineTool } from '../src/tools/types.ts'

const echo = defineTool({ name: 'echo', description: '', schema: z.object({ text: z.string() }), run: async ({ text }) => `echo ${text}` })

function setup() {
  const repos = createRepos(openDatabase(':memory:'))
  const registry = new ToolRegistry().register(echo, createSkill, runSkill, reviseSkill)
  const ctx = { bot: {} as Bot, repos, log: () => {}, signal: new AbortController().signal }
  return { repos, run: (tool: string, args: unknown) => registry.run(tool, args, ctx) }
}

describe('skill tools', () => {
  it('creates a skill and runs it with args, recording success', async () => {
    const { repos, run } = setup()
    const code = 'const a = await tools.echo({ text: args.who }); const b = await tools.echo({ text: "again" }); log(a); return [a, b]'
    expect(await run('create_skill', { name: 'greet_twice', description: 'echo twice', code })).toBe('saved skill greet_twice')
    expect(await run('run_skill', { name: 'greet_twice', args: { who: 'Steve' } })).toBe('skill returned ["echo Steve","echo again"]; log: echo Steve')
    expect(repos.skills.get('greet_twice')).toMatchObject({ successes: 1, failures: 0 })
  })

  it('rejects duplicate names, bad names and syntax errors', async () => {
    const { run } = setup()
    await run('create_skill', { name: 'chop', description: 'chop', code: 'return 1' })
    await expect(run('create_skill', { name: 'chop', description: 'chop', code: 'return 1' })).rejects.toThrow(/already exists/)
    await expect(run('create_skill', { name: 'Bad Name', description: 'x', code: 'return 1' })).rejects.toThrow(/invalid arguments/)
    await expect(run('create_skill', { name: 'broken', description: 'x', code: 'return (' })).rejects.toThrow(/syntax error/)
  })

  it('records failures with the reason', async () => {
    const { repos, run } = setup()
    await run('create_skill', { name: 'bad_echo', description: 'x', code: 'await tools.echo({})' })
    await expect(run('run_skill', { name: 'bad_echo' })).rejects.toThrow(/skill bad_echo failed: invalid arguments for echo/)
    expect(repos.skills.get('bad_echo')).toMatchObject({ successes: 0, failures: 1 })
    await expect(run('run_skill', { name: 'missing' })).rejects.toThrow(/no skill named missing/)
  })

  it('revises code and description', async () => {
    const { repos, run } = setup()
    await run('create_skill', { name: 'chop', description: 'old', code: 'return 1' })
    expect(await run('revise_skill', { name: 'chop', code: 'return 2', description: 'new' })).toBe('revised skill chop')
    expect(repos.skills.get('chop')).toMatchObject({ code: 'return 2', description: 'new' })
    await expect(run('revise_skill', { name: 'nope', code: 'return 1' })).rejects.toThrow(/no skill named nope/)
  })
})
