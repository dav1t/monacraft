import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos, type Repos } from '../src/db/repos.ts'
import type { Decision, LLMProvider } from '../src/llm/types.ts'
import { consolidate, NAP_AFTER_ENTRIES, reflectionInput, SleepScheduler, writeJournalSpec } from '../src/sleep.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { defineTool } from '../src/tools/types.ts'

function fakeProvider(replies: Array<Decision | Error>) {
  const requests: { system: string; user: string; tools: string[]; purpose?: string }[] = []
  const provider: LLMProvider = {
    name: 'fake',
    decide: async ({ system, user, tools, purpose }) => {
      requests.push({ system, user, tools: tools.map((t) => t.name), ...(purpose && { purpose }) })
      const reply = replies.shift()
      if (!reply) throw new Error('out of replies')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { provider, requests }
}

const journal = (args: Record<string, unknown>): Decision => ({ thought: '', tool: 'write_journal', args })
const waits: number[] = []
const quiet = { name: 'Mindy', log: () => {}, wait: async (ms: number) => void waits.push(ms) }

describe('consolidate', () => {
  it('writes the journal, lessons, memory and goal changes, and starts a new day', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.history.add('action', 'mine oak_log → ok')
    repos.memory.set('base', '0 64 0')
    repos.memory.set('old_cave', '5 40 5')
    repos.lessons.add('players are friends', 'player')
    const goal = repos.goals.create({ parentId: null, kind: 'goal', title: 'find a village', status: 'active' })
    repos.skills.create({ name: 'chop', description: 'chop', code: 'return 1' })
    const { provider, requests } = fakeProvider([
      journal({
        journal: 'Chopped trees. Found nothing else.',
        lessons: ['logs need no tool', 'logs need no tool', 'players are friends'],
        memory: { set: { forest: '30 64 10' }, delete: ['old_cave'] },
        goals: [{ id: goal.id, status: 'dropped', note: 'too far' }, { id: 999, status: 'done' }],
        skills_to_review: ['chop', 'ghost_skill'],
      }),
    ])
    const day = await consolidate({ repos, provider, ...quiet }, 'sleep')
    expect(requests[0]?.tools).toEqual(['write_journal'])
    expect(requests[0]?.purpose).toBe('reflection')
    expect(requests[0]?.user).toContain('[action] mine oak_log → ok')
    expect(requests[0]?.user).toContain(`[${goal.id}] goal: find a village (active)`)
    expect(day).toMatchObject({ kind: 'sleep', journal: 'Chopped trees. Found nothing else.', skills_review: ['chop'] })
    expect(repos.lessons.list().map((l) => `${l.source}:${l.content}`)).toEqual(['player:players are friends', 'sleep:logs need no tool'])
    expect(repos.memory.all()).toEqual({ base: '0 64 0', forest: '30 64 10' })
    expect(repos.goals.get(goal.id)).toMatchObject({ status: 'dropped', note: 'too far' })
    // The new day starts with an empty prompt history.
    expect(repos.history.recent(15, repos.days.todayAfter())).toEqual([])
  })

  it('never deletes or overwrites pinned memory and caps the lessons', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.memory.set('base', '0 64 0')
    repos.memory.setPinned('base', true)
    const { provider } = fakeProvider([
      journal({
        journal: 'x',
        lessons: Array.from({ length: 20 }, (_, i) => `lesson ${i}`),
        memory: { set: [{ key: 'base', value: 'moved' }], delete: ['base'] },
      }),
    ])
    await consolidate({ repos, provider, ...quiet }, 'nap')
    expect(repos.memory.all()).toEqual({ base: '0 64 0' })
    expect(repos.lessons.list()).toHaveLength(12)
  })

  it('retries invalid output right away, then ends the day without reflecting', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.history.add('event', 'something')
    const say = { thought: '', tool: 'say', args: {} }
    const { provider, requests } = fakeProvider([say, journal({ lessons: [] }), say])
    waits.length = 0
    const day = await consolidate({ repos, provider, ...quiet }, 'sleep')
    expect(requests).toHaveLength(3)
    expect(waits).toEqual([])
    expect(day.journal).toBe('Slept without reflecting.')
    expect(repos.days.todayAfter()).toBe(repos.history.lastId())
  })

  it('waits longer before each retry after a failed request such as a rate limit', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.history.add('event', 'something')
    const limited = new Error('429 Provider returned error')
    const { provider, requests } = fakeProvider([limited, limited, journal({ journal: 'Survived.', lessons: ['skeletons shoot from afar'] })])
    waits.length = 0
    const day = await consolidate({ repos, provider, ...quiet }, 'sleep')
    expect(requests).toHaveLength(3)
    expect(waits).toEqual([10_000, 30_000])
    expect(day.journal).toBe('Survived.')
  })

  it('saves the journal when the model wraps a field in the JSON schema (as qwen3:8b does)', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const goal = repos.goals.create({ parentId: null, kind: 'goal', title: 'explore', status: 'active' })
    const sub = repos.goals.create({ parentId: goal.id, kind: 'subgoal', title: 'look around', status: 'active' })
    repos.history.add('event', 'something happened')
    const logs: string[] = []
    const { provider } = fakeProvider([
      journal({
        // The real reply: the array came back inside { items, type }, with one item that is not a change.
        goals: { items: [{ id: sub.id, status: 'done' }, { id: goal.id, status: 'active' }], type: 'array' },
        journal: 'Explored a forest.',
        lessons: ['oak_log needs no tool'],
        memory: { delete: [], set: { forest: '127 74 -1494' } },
        skills_to_review: 'not a list',
      }),
    ])
    const day = await consolidate({ repos, provider, name: 'Mona', log: (l) => logs.push(l) }, 'sleep')
    expect(day.journal).toBe('Explored a forest.')
    expect(repos.goals.get(sub.id)?.status).toBe('done')
    expect(repos.goals.get(goal.id)?.status).toBe('active')
    expect(repos.memory.all()).toEqual({ forest: '127 74 -1494' })
    expect(repos.lessons.list().map((l) => l.content)).toEqual(['oak_log needs no tool'])
    expect(logs).toContain('reflection: ignored unreadable skills_to_review')
  })

  it('unwraps a field nested under its own name', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const goal = repos.goals.create({ parentId: null, kind: 'goal', title: 'get stone_pickaxe', status: 'active' })
    const { provider } = fakeProvider([journal({ journal: 'Made a pickaxe.', goals: { goals: [{ id: goal.id, status: 'done' }] } })])
    await consolidate({ repos, provider, ...quiet }, 'sleep')
    expect(repos.goals.get(goal.id)?.status).toBe('done')
  })

  it('describes write_journal as a JSON schema tool', () => {
    expect(writeJournalSpec()).toMatchObject({ name: 'write_journal', parameters: { type: 'object', required: expect.arrayContaining(['journal', 'lessons']) } })
  })

  it('truncates long history entries in the reflection input', () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.history.add('action', 'x'.repeat(500))
    expect(reflectionInput(repos)).toContain(`[action] ${'x'.repeat(199)}…`)
  })
})

class FakeBot extends EventEmitter {
  time = { timeOfDay: 6000, day: 3 }
  isSleeping = false
  woke = 0
  async wake(): Promise<void> {
    this.woke++
    this.isSleeping = false
  }
}

function schedulerSetup(replies: Array<Decision | Error>) {
  const repos = createRepos(openDatabase(':memory:'))
  const bot = new FakeBot()
  const calls: string[] = []
  const agent = { promptChars: 0, pause: () => calls.push('pause'), resume: () => calls.push('resume') }
  const { provider } = fakeProvider(replies)
  const scheduler = new SleepScheduler({ bot, agent, repos, provider, ...quiet })
  return { repos, bot, agent, calls, scheduler }
}

const eventsOf = (repos: Repos) => repos.history.recent(50).map((h) => h.content)

describe('SleepScheduler', () => {
  it('announces dusk once and consolidates at night even without a bed', async () => {
    const { repos, bot, calls, scheduler } = schedulerSetup([journal({ journal: 'A long day.' })])
    for (let i = 0; i < 5; i++) repos.history.add('action', `step ${i}`)
    scheduler.tick()
    expect(eventsOf(repos).some((e) => e.startsWith('night is falling'))).toBe(false)
    bot.time.timeOfDay = 12_100
    scheduler.tick()
    scheduler.tick()
    expect(eventsOf(repos).filter((e) => e.startsWith('night is falling'))).toHaveLength(1)
    bot.time.timeOfDay = 13_100
    scheduler.tick()
    expect(scheduler.busy).toBe(true)
    await sleep(20)
    expect(calls).toEqual(['pause', 'resume'])
    expect(repos.days.latest()).toMatchObject({ kind: 'sleep', journal: 'A long day.' })
    scheduler.tick()
    expect(repos.days.list(10)).toHaveLength(1)
  })

  it('skips a night with nothing to reflect on', () => {
    const { repos, bot, calls, scheduler } = schedulerSetup([])
    bot.time.timeOfDay = 15_000
    scheduler.tick()
    scheduler.tick()
    expect(calls).toEqual([])
    expect(repos.days.latest()).toBeUndefined()
  })

  it('consolidates when the bot lies down, and gets up if it is still night', async () => {
    const { repos, bot, scheduler } = schedulerSetup([journal({ journal: 'Slept.' })])
    const stop = scheduler.start()
    bot.time.timeOfDay = 12_600
    bot.isSleeping = true
    bot.emit('sleep')
    await sleep(20)
    stop()
    expect(bot.woke).toBe(1)
    expect(eventsOf(repos)).toContain('it is still night: stay near your bed or shelter until morning')
  })

  it('naps when the day gets too long', async () => {
    const { repos, scheduler } = schedulerSetup([journal({ journal: 'Busy.' })])
    for (let i = 0; i <= NAP_AFTER_ENTRIES; i++) repos.history.add('action', `step ${i}`)
    scheduler.tick()
    await sleep(20)
    expect(repos.days.latest()?.kind).toBe('nap')
  })
})

describe('Agent.pause', () => {
  it('stops new steps while paused but lets reflexes run', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    let decisions = 0
    const echo = defineTool({ name: 'echo', description: '', schema: z.object({}), run: async () => 'echo' })
    const agent = new Agent({
      provider: {
        name: 'fake',
        decide: async () => {
          decisions++
          return { thought: '', tool: 'echo', args: {} }
        },
      },
      registry: new ToolRegistry().register(echo),
      repos,
      systemPrompt: 'sys',
      observe: () => ({}),
      context: { bot: {} as Bot, repos, log: () => {} },
      log: () => {},
    })
    agent.pause()
    const running = agent.run()
    await sleep(30)
    expect(decisions).toBe(0)
    expect(await agent.exclusive('reflex: eating', async () => 'ate')).toBe('ate')
    agent.resume()
    await sleep(30)
    agent.stop()
    await running
    expect(decisions).toBeGreaterThan(0)
    expect(agent.promptChars).toBeGreaterThan(0)
  })
})
