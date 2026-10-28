import { setTimeout as sleep } from 'node:timers/promises'
import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, type AgentEvent } from '../src/agent/agent.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { FatalLLMError, LLMFormatError, type ConverseRequest, type Decision, type LLMProvider } from '../src/llm/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { defineTool } from '../src/tools/types.ts'

const echo = defineTool({ name: 'echo', description: '', schema: z.object({ text: z.string() }), run: async ({ text }) => `echo ${text}` })
const slow = defineTool({ name: 'slow', description: '', schema: z.object({}), run: (_args, { signal }) => sleep(5_000, 'finished', { signal }) })
const broken = defineTool({ name: 'broken', description: '', schema: z.object({}), run: async () => { throw new Error('no pickaxe') } })
const wait = defineTool({ name: 'wait', description: '', schema: z.object({}), run: (_args, { signal }) => sleep(5_000, 'waited', { signal }) })
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
    registry: new ToolRegistry().register(echo, slow, broken, hang, wait),
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
  it('pauses after a failed step, and stop() cuts the pause short', async () => {
    const { agent, prompts } = setup([new Error('429 Provider returned error')])
    const run = agent.run()
    await sleep(50)
    expect(prompts).toHaveLength(1)
    const started = Date.now()
    agent.stop()
    await run
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(prompts).toHaveLength(1)
  })

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
    expect(lastEntry()).toContain('→ interrupted: Steve said something — answer, then pick this action up again if it still makes sense')
    await agent.step()
    expect(prompts[1]).toContain('## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n<Steve> come here')
    expect(repos.history.recent(2)[0]?.content).toBe('<Steve> come here')
  })

  it('lets chat that is not urgent wait for the next decision without interrupting or skipping anything', async () => {
    const { agent, prompts, lastEntry } = setup([decide('slow'), decide('echo', { text: 'x' })], 100)
    const step = agent.step()
    await sleep(50)
    agent.onChat('Bob', 'hello', false)
    await step
    expect(lastEntry()).toContain('→ interrupted: time limit of 0.1s reached')
    await agent.step()
    expect(prompts[1]).toContain('<Bob> hello')
    expect(lastEntry()).toContain('→ ok: echo x')
  })

  it('still cuts a wait short for chat that is not urgent', async () => {
    const { agent, lastEntry } = setup([decide('wait')])
    const step = agent.step()
    await sleep(50)
    agent.onChat('Bob', 'hello', false)
    await step
    expect(lastEntry()).toContain('→ interrupted: Bob said something')
  })

  it('tells which tool is running, so the eyes know what they would interrupt', async () => {
    const { agent } = setup([decide('slow')])
    expect(agent.currentTool).toBeNull()
    const step = agent.step()
    await sleep(50)
    expect(agent.currentTool).toBe('slow')
    agent.interrupt('a zombie')
    await step
    expect(agent.currentTool).toBeNull()
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
    expect(lastEntry()).toContain('skipped: reflex: eating — it happened while you were deciding')
  })

  it('stops thinking when interrupted, keeps the chat, and decides again with the news', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const prompts: string[] = []
    const events: AgentEvent[] = []
    const agent = new Agent({
      provider: {
        name: 'fake',
        // The first call thinks until it is cancelled; the second answers at once.
        decide: ({ user, signal }) => {
          prompts.push(user)
          if (prompts.length > 1) return Promise.resolve(decide('echo', { text: 'x' }))
          return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        },
      },
      registry: new ToolRegistry().register(echo),
      repos,
      systemPrompt: 'sys',
      observe: () => ({}),
      context: { bot: {} as Bot, repos, log: () => {} },
      log: () => {},
      onEvent: (event) => events.push(event),
    })
    agent.onChat('Steve', 'hi')
    const step = agent.step()
    await sleep(20)
    agent.interrupt('you died')
    await step
    expect(events).toContainEqual({ type: 'interrupted', reason: 'you died' })
    expect(repos.history.recent(10).some((h) => h.kind === 'action')).toBe(false)
    await agent.step()
    expect(prompts[1]).toContain('<Steve> hi')
    expect(repos.history.recent(1)[0]?.content).toContain('→ ok: echo x')
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

describe('Agent token usage', () => {
  it('reports the provider count, or estimates about 4 characters per token', async () => {
    const events: unknown[] = []
    const run = async (reply: Decision) => {
      const repos = createRepos(openDatabase(':memory:'))
      const agent = new Agent({
        provider: { name: 'fake', decide: async () => reply },
        registry: new ToolRegistry().register(echo),
        repos,
        systemPrompt: 'sys',
        observe: () => ({}),
        context: { bot: {} as Bot, repos, log: () => {} },
        log: () => {},
        onEvent: (e) => e.type === 'usage' && events.push(e),
      })
      await agent.step()
    }
    await run({ ...decide('echo', { text: 'x' }), promptTokens: 1234 })
    await run(decide('echo', { text: 'x' }))
    expect(events[0]).toEqual({ type: 'usage', promptTokens: 1234, estimated: false })
    expect(events[1]).toMatchObject({ type: 'usage', estimated: true, promptTokens: expect.any(Number) })
  })
})

describe('Agent conversations', () => {
  /** A provider that keeps one conversation per startConversation() and records every turn. */
  function conversational(replies: Array<Decision | Error>, tokens = 1_000) {
    const turns: { conversation: number; request: ConverseRequest }[] = []
    let started = 0
    const provider: LLMProvider = {
      name: 'fake',
      decide: async () => {
        throw new Error('decide() should not be used')
      },
      startConversation: () => {
        const id = ++started
        return {
          closed: false,
          contextTokens: tokens,
          next: async (request: ConverseRequest) => {
            turns.push({ conversation: id, request })
            const reply = replies.shift()
            if (!reply) throw new Error('out of replies')
            if (reply instanceof Error) throw reply
            return reply
          },
        }
      },
    }
    const repos = createRepos(openDatabase(':memory:'))
    const agent = new Agent({
      provider,
      registry: new ToolRegistry().register(echo, broken),
      repos,
      systemPrompt: 'sys',
      observe: () => ({ health: 20 }),
      context: { bot: {} as Bot, repos, log: () => {} },
      log: () => {},
    })
    return { agent, repos, turns }
  }

  it('sends the full prompt once, then the tool result and a short update', async () => {
    const { agent, turns } = conversational([decide('echo', { text: 'a' }), decide('broken'), decide('echo', { text: 'b' })])
    await agent.step()
    await agent.step()
    await agent.step()
    expect(turns.map((t) => t.conversation)).toEqual([1, 1, 1])
    expect(turns[0]!.request.user).toContain('## Memory')
    expect(turns[0]!.request.result).toBeUndefined()
    expect(turns[1]!.request.result).toEqual({ outcome: 'ok: echo a', isError: false })
    expect(turns[1]!.request.user).not.toContain('## Memory')
    expect(turns[1]!.request.user).toContain('## Situation\n{"health":20}')
    expect(turns[2]!.request.result).toEqual({ outcome: 'error: no pickaxe', isError: true })
  })

  it('reports what happened between steps, but not its own actions again', async () => {
    const { agent, repos, turns } = conversational([decide('echo', { text: 'a' }), decide('echo', { text: 'b' })])
    await agent.step()
    repos.history.add('event', 'reflex (eating): ate bread')
    agent.onChat('Steve', 'hi')
    await agent.step()
    const update = turns[1]!.request.user
    expect(update).toContain('[event] reflex (eating): ate bread')
    expect(update).toContain('<Steve> hi')
    expect(update).not.toContain('echo {"text":"a"}')
  })

  it('starts a new conversation on a new day and when the context gets too long', async () => {
    const day = conversational([decide('echo', { text: 'a' }), decide('echo', { text: 'b' })])
    await day.agent.step()
    day.repos.days.add({ kind: 'sleep', startedAt: '2026-10-26 20:00:00', journal: 'slept', historyUntil: day.repos.history.lastId(), skillsReview: [] })
    await day.agent.step()
    expect(day.turns.map((t) => t.conversation)).toEqual([1, 2])
    expect(day.turns[1]!.request.user).toContain('## Memory')
    expect(day.turns[1]!.request.result).toBeUndefined()

    const long = conversational([decide('echo', { text: 'a' }), decide('echo', { text: 'b' })], 500_000)
    await long.agent.step()
    await long.agent.step()
    expect(long.turns.map((t) => t.conversation)).toEqual([1, 2])
  })

  it('keeps the result for the retry when the model call fails', async () => {
    const { agent, turns } = conversational([decide('echo', { text: 'a' }), new Error('overloaded'), decide('echo', { text: 'b' })])
    await agent.step()
    await expect(agent.step()).rejects.toThrow('overloaded')
    await agent.step()
    expect(turns[2]!.request.result).toEqual({ outcome: 'ok: echo a', isError: false })
    expect(turns[2]!.conversation).toBe(1)
  })
})
