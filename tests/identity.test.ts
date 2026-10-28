import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../src/agent/prompt.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { drawSeeds, ensureIdentity } from '../src/identity.ts'
import { LLMFormatError, type Decision, type LLMProvider } from '../src/llm/types.ts'
import { consolidate, reflectionInput, reflectionPrompt } from '../src/sleep.ts'

function fakeProvider(replies: Array<Decision | Error>) {
  const requests: { system: string; user: string }[] = []
  const provider: LLMProvider = {
    name: 'fake',
    decide: async ({ system, user }) => {
      requests.push({ system, user })
      const reply = replies.shift()
      if (!reply) throw new Error('out of replies')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { provider, requests }
}

const identity = (args: Record<string, unknown>): Decision => ({ thought: '', tool: 'write_identity', args })
const journal = (args: Record<string, unknown>): Decision => ({ thought: '', tool: 'write_journal', args })
const quiet = { name: 'Mindy', log: () => {}, wait: async () => {} }

/** Always the first entry of every pool. */
const first = (): number => 0

describe('IdentityRepo', () => {
  it('adds a version only when something changed', () => {
    const repos = createRepos(openDatabase(':memory:'))
    expect(repos.identity.update({ self: 'I like bridges.', wants: 'a bridge', reason: 'birth', seeds: 'x' })).toBe(true)
    expect(repos.identity.update({ self: 'I like bridges.', wants: 'a bridge', reason: 'sleep' })).toBe(false)
    expect(repos.identity.update({ self: 'I like bridges.', wants: 'a longer bridge', reason: 'sleep' })).toBe(true)
    expect(repos.identity.list(10).map((v) => v.reason)).toEqual(['sleep', 'birth'])
    expect(repos.identity.current()?.wants).toBe('a longer bridge')
  })
})

describe('ensureIdentity', () => {
  it('lets the bot write its own identity from chance words', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const { provider, requests } = fakeProvider([
      new LLMFormatError('garbled'),
      identity({ self: 'I am a patient soul who loves high places.', wants: 'Build a lookout on the mountain.' }),
    ])
    await ensureIdentity({ repos, provider, ...quiet, random: first })
    expect(drawSeeds(first)).toBe('temperament: patient, restless; drawn to: high places, the sound of water; afraid of: the dark')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.user).toContain(drawSeeds(first))
    expect(repos.identity.current()).toMatchObject({
      self: 'I am a patient soul who loves high places.',
      wants: 'Build a lookout on the mountain.',
      reason: 'birth',
      seeds: drawSeeds(first),
    })
  })

  it('does nothing for a bot that already has one', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.identity.update({ self: 'me', wants: 'things', reason: 'player' })
    const { provider, requests } = fakeProvider([])
    await ensureIdentity({ repos, provider, ...quiet })
    expect(requests).toHaveLength(0)
  })

  it('lives on without one when the model cannot answer', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const logs: string[] = []
    const { provider } = fakeProvider([new Error('down'), new Error('down'), new Error('down')])
    await ensureIdentity({ repos, provider, ...quiet, log: (l) => logs.push(l) })
    expect(repos.identity.current()).toBeUndefined()
    expect(logs.at(-1)).toContain('no identity yet')
  })
})

describe('reflecting on a death', () => {
  it('gives the scar its meaning and lets the death change who the bot is', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.identity.update({ self: 'I love caves.', wants: 'map the caves', reason: 'birth' })
    repos.scars.add({ cause: 'died (fell from a high place)', place: '1 2 3', lost: 'nothing' })
    repos.scars.setMeaning(repos.scars.list()[0]!.id, 'heights are not for me')
    repos.scars.add({ cause: 'died (blown up by Creeper)', place: '10 40 -5', lost: '12 coal' })
    repos.history.add('action', 'mine coal_ore → ok')
    const { provider, requests } = fakeProvider([
      journal({
        journal: 'I mined coal deep down until a creeper got me.',
        scar: 'The caves bit back. I will light them before I love them.',
        identity: { self: 'I love caves, but I respect them now.', wants: 'light up the big cave, then map it' },
      }),
    ])
    const day = await consolidate({ repos, provider, ...quiet }, 'death')

    expect(requests[0]?.system).toBe(reflectionPrompt('Mindy', 'death'))
    expect(requests[0]?.user).toContain('## How you died\ndied (blown up by Creeper) at 10 40 -5. You carried: 12 coal.')
    expect(requests[0]?.user).toContain('## Earlier deaths\n- died (fell from a high place) at 1 2 3 — heights are not for me')
    expect(requests[0]?.user).toContain('## Who you are\nI love caves.')
    expect(day.kind).toBe('death')
    expect(repos.scars.list()[0]?.meaning).toBe('The caves bit back. I will light them before I love them.')
    expect(repos.scars.unreflected()).toBeUndefined()
    expect(repos.identity.current()).toMatchObject({ self: 'I love caves, but I respect them now.', reason: 'death' })
  })

  it('leaves the identity alone when a night changed nothing', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.identity.update({ self: 'I like bees.', wants: 'a bee farm', reason: 'birth' })
    repos.history.add('action', 'mine oak_log → ok')
    const { provider } = fakeProvider([journal({ journal: 'Chopped wood.' })])
    await consolidate({ repos, provider, ...quiet }, 'sleep')
    expect(repos.identity.list(10)).toHaveLength(1)
    expect(reflectionInput(repos)).not.toContain('## How you died')
  })
})

describe('the agent prompt', () => {
  it('shows who the bot is and its scars, and no longer hands it the gear ladder', () => {
    const text = buildUserPrompt({
      snapshot: {},
      goal: null,
      memory: [],
      skills: [],
      history: [],
      chat: [],
      identity: { self: 'I am a gardener at heart.', wants: 'a flower field by the river' },
      scars: ['died (drowned) at 1 60 1 — I keep away from deep water'],
    })
    expect(text).toContain('## Who you are\nI am a gardener at heart.\n\nWhat you want now: a flower field by the river')
    expect(text).toContain('## Scars — deaths that shaped you\n- died (drowned) at 1 60 1 — I keep away from deep water')
    expect(buildSystemPrompt('Mindy')).not.toContain('wooden_pickaxe → cobblestone')
  })
})
