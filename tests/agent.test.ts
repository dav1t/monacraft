import { setTimeout as sleep } from 'node:timers/promises'
import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { FatalLLMError, LLMFormatError, type Decision, type LLMProvider } from '../src/llm/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { defineTool } from '../src/tools/types.ts'

const echo = defineTool({ name: 'echo', description: '', schema: z.object({ text: z.string() }), run: async ({ text }) => `echo ${text}` })
const slow = defineTool({ name: 'slow', description: '', schema: z.object({}), run: (_args, { signal }) => sleep(5_000, 'finished', { signal }) })
const broken = defineTool({ name: 'broken', description: '', schema: z.object({}), run: async () => { throw new Error('no pickaxe') } })
const hang = defineTool({ name: 'hang', description: '', schema: z.object({}), run: () => sleep(5_000, 'late') })

function setup(replies: Array<Decision | Error>, actionTimeoutMs = 2_000) {
  const repos = createRepos(openDatabase(':memory:'))
  const prompts: string[] = []
  const provider: LLMProvider = {
    name: 'fake',
    decide: async ({ user }) => {
      prompts.push(user)
      const reply = replies.shift()
      if (!reply) throw new Error('out of replies')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  const agent = new Agent({
    provider,
    registry: new ToolRegistry().register(echo, slow, broken, hang),
    repos,
    systemPrompt: 'sys',
    observe: () => ({ health: 20 }),
    context: { bot: {} as Bot, repos, log: () => {} },
    log: () => {},
    actionTimeoutMs,
  })
  const lastEntry = () => repos.history.recent(1)[0]?.content ?? ''
  return { agent, repos, prompts, lastEntry }
}

const decide = (tool: string, args: Record<string, unknown> = {}): Decision => ({ thought: `use ${tool}`, tool, args })

describe('Agent.run', () => {
  it('rejects instead of retrying on a FatalLLMError', async () => {
    const { agent } = setup([new FatalLLMError('m does not support tool calling')])
    await expect(agent.run()).rejects.toThrow('m does not support tool calling')
  })
})

describe('Agent.step', () => {
  it('runs the chosen tool and records the outcome', async () => {
    const { agent, prompts, lastEntry } = setup([decide('echo', { text: 'hi' })])
    await agent.step()
    expect(prompts[0]).toContain('## Situation\n{"health":20}')
    expect(lastEntry()).toBe('(use echo) echo {"text":"hi"} → ok: echo hi')
  })

  it('records tool failures and unknown tools', async () => {
    const { agent, lastEntry } = setup([decide('broken'), decide('fly')])
    await agent.step()
    expect(lastEntry()).toContain('→ error: no pickaxe')
    await agent.step()
    expect(lastEntry()).toContain('→ error: unknown tool "fly"')
  })

  it('interrupts the action when a player chats and shows the chat next step', async () => {
    const { agent, prompts, lastEntry, repos } = setup([decide('slow'), decide('echo', { text: 'hello' })])
    const step = agent.step()
    await sleep(50)
    agent.onChat('Steve', 'come here')
    await step
    expect(lastEntry()).toContain('→ interrupted: Steve said something')
    await agent.step()
    expect(prompts[1]).toContain('## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n<Steve> come here')
    expect(repos.history.recent(2)[0]?.content).toBe('<Steve> come here')
  })

  it('enforces the action time limit', async () => {
    const { agent, lastEntry } = setup([decide('slow')], 50)
    await agent.step()
    expect(lastEntry()).toContain('→ interrupted: time limit of 0.05s reached')
  })

  it('exclusive() interrupts the running action, then runs its function', async () => {
    const { agent, lastEntry } = setup([decide('slow')])
    const step = agent.step()
    await sleep(50)
    expect(await agent.exclusive('reflex: eating', async () => 'ate bread')).toBe('ate bread')
    await step
    expect(lastEntry()).toContain('→ interrupted: reflex: eating')
  })

  it('records invalid LLM replies so the model can correct itself', async () => {
    const { agent, lastEntry } = setup([new LLMFormatError('no tool call in reply: "hmm"')])
    await agent.step()
    expect(lastEntry()).toContain('no tool call in reply')
  })

  it('propagates other LLM failures (e.g. Ollama not running)', async () => {
    const { agent } = setup([new Error('fetch failed')])
    await expect(agent.step()).rejects.toThrow('fetch failed')
  })

  it('keeps chat that was not answered because the LLM call failed', async () => {
    const { agent, prompts, repos } = setup([new Error('fetch failed'), decide('echo', { text: 'x' })])
    agent.onChat('Steve', 'hi')
    await expect(agent.step()).rejects.toThrow('fetch failed')
    await agent.step()
    expect(prompts[1]).toContain('## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n<Steve> hi')
    expect(repos.history.recent(50).filter((h) => h.content === '<Steve> hi')).toHaveLength(1)
  })

  it('skips a decision made before a reflex ran', async () => {
    const { agent, lastEntry } = setup([decide('echo', { text: 'x' })])
    const step = agent.step()
    await agent.exclusive('reflex: eating', async () => 'ate')
    await step
    expect(lastEntry()).toContain('skipped: a reflex ran while you were deciding')
  })

  it('keeps unread chat when building the prompt throws', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const prompts: string[] = []
    let fail = true
    const agent = new Agent({
      provider: {
        name: 'fake',
        decide: async ({ user }) => {
          prompts.push(user)
          return decide('echo', { text: 'x' })
        },
      },
      registry: new ToolRegistry().register(echo),
      repos,
      systemPrompt: 'sys',
      observe: () => {
        if (fail) throw new Error('observe failed')
        return {}
      },
      context: { bot: {} as Bot, repos, log: () => {} },
      log: () => {},
    })
    agent.onChat('Steve', 'hi')
    await expect(agent.step()).rejects.toThrow('observe failed')
    fail = false
    await agent.step()
    expect(prompts[0]).toContain('<Steve> hi')
  })

  it('times out a tool that ignores its abort signal', async () => {
    const { agent, lastEntry } = setup([decide('hang')], 50)
    const started = Date.now()
    await agent.step()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(lastEntry()).toContain('interrupted: time limit of 0.05s reached')
  })

  it('does not run the decided action after stop()', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    let ran = false
    const record = defineTool({ name: 'record', description: '', schema: z.object({}), run: async () => { ran = true; return 'recorded' } })
    const agent: Agent = new Agent({
      provider: {
        name: 'fake',
        decide: async () => {
          agent.stop()
          return decide('record')
        },
      },
      registry: new ToolRegistry().register(record),
      repos,
      systemPrompt: 'sys',
      observe: () => ({}),
      context: { bot: {} as Bot, repos, log: () => {} },
      log: () => {},
    })
    await agent.step()
    expect(ran).toBe(false)
    expect(repos.history.recent(1)[0]?.content).toContain('skipped: shutting down')
  })
})
