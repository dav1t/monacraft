import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import type { CallRecord } from '../src/llm/providers.ts'

const fresh = () => createRepos(openDatabase(':memory:'))

describe('SkillRepo', () => {
  it('creates, lists, updates and scores skills', () => {
    const { skills } = fresh()
    skills.create({ name: 'chop', description: 'chop trees', code: 'return 1' })
    skills.create({ name: 'build', description: 'build hut', code: 'return 2' })
    expect(skills.list().map((s) => s.name)).toEqual(['build', 'chop'])
    expect(skills.get('chop')).toEqual({ name: 'chop', description: 'chop trees', code: 'return 1', successes: 0, failures: 0 })

    expect(skills.update('chop', { code: 'return 3' })).toBe(true)
    expect(skills.update('missing', { code: 'x' })).toBe(false)
    skills.recordResult('chop', true)
    skills.recordResult('chop', false)
    skills.recordResult('chop', true)
    expect(skills.get('chop')).toMatchObject({ code: 'return 3', description: 'chop trees', successes: 2, failures: 1 })
    expect(skills.get('nope')).toBeUndefined()
  })

  it('rejects duplicate names', () => {
    const { skills } = fresh()
    skills.create({ name: 'chop', description: 'a', code: 'b' })
    expect(() => skills.create({ name: 'chop', description: 'a', code: 'b' })).toThrow()
  })
})

describe('MemoryRepo', () => {
  it('upserts, reads, lists and deletes facts', () => {
    const { memory } = fresh()
    memory.set('base', '0 64 0')
    memory.set('base', '10 70 -5')
    memory.set('goal', 'get iron')
    expect(memory.get('base')).toBe('10 70 -5')
    expect(memory.all()).toEqual({ base: '10 70 -5', goal: 'get iron' })
    expect(memory.delete('base')).toBe(true)
    expect(memory.delete('base')).toBe(false)
    expect(memory.get('base')).toBeUndefined()
  })
})

describe('HistoryRepo', () => {
  it('returns the most recent entries, oldest first', () => {
    const { history } = fresh()
    for (const n of [1, 2, 3, 4]) history.add('action', `step ${n}`)
    history.add('chat', '<Steve> hi')
    expect(history.recent(3).map((h) => `${h.kind}:${h.content}`)).toEqual(['action:step 3', 'action:step 4', 'chat:<Steve> hi'])
  })
})

describe('HistoryRepo editing', () => {
  it('pages newest first, deletes single entries and clears', () => {
    const { history } = fresh()
    for (const n of [1, 2, 3, 4, 5]) history.add('event', `e${n}`)
    const first = history.page(2)
    expect(first.map((h) => h.content)).toEqual(['e5', 'e4'])
    expect(history.page(2, first[1]?.id).map((h) => h.content)).toEqual(['e3', 'e2'])
    expect(history.delete(first[0]!.id)).toBe(true)
    expect(history.delete(first[0]!.id)).toBe(false)
    expect(history.page(10)).toHaveLength(4)
    history.clear()
    expect(history.page(10)).toEqual([])
  })
})

describe('SkillRepo.delete', () => {
  it('removes a skill once', () => {
    const { skills } = fresh()
    skills.create({ name: 'chop', description: 'a', code: 'b' })
    expect(skills.delete('chop')).toBe(true)
    expect(skills.delete('chop')).toBe(false)
  })
})

describe('RevelationRepo', () => {
  it('adds, edits, lists in order and deletes', () => {
    const { revelations } = fresh()
    const a = revelations.add('iron is below y=16')
    revelations.add('your base is at 0 64 0')
    expect(a).toMatchObject({ id: expect.any(Number), content: 'iron is below y=16' })
    expect(revelations.update(a.id, 'iron is common below y=16')).toBe(true)
    expect(revelations.list().map((r) => r.content)).toEqual(['iron is common below y=16', 'your base is at 0 64 0'])
    expect(revelations.delete(a.id)).toBe(true)
    expect(revelations.delete(a.id)).toBe(false)
    expect(revelations.update(a.id, 'x')).toBe(false)
    expect(revelations.list()).toHaveLength(1)
  })
})

describe('UsageRepo', () => {
  const call = (model: string, extra: Partial<CallRecord> = {}): CallRecord => ({
    provider: 'openrouter',
    model,
    kind: 'decision',
    usage: {},
    durationMs: 1000,
    ...extra,
  })

  it('sums cost, tokens and time per model, keeping reflections out of the decision stats', () => {
    const { usage } = createRepos(openDatabase(':memory:'))
    usage.record(1, call('a/b', { usage: { inputTokens: 100, outputTokens: 10, cost: 0.01 } }))
    usage.record(1, call('a/b', { usage: { inputTokens: 200, outputTokens: 20, cost: 0.02 }, durationMs: 3000 }))
    usage.record(1, call('a/b', { kind: 'reflection', usage: { inputTokens: 1000, cost: 0.5 }, durationMs: 9000 }))
    const [row] = usage.stats()
    expect(row).toEqual({ provider: 'openrouter', model: 'a/b', decisions: 2, failed: 0, inputTokens: 1300, outputTokens: 30, cost: 0.53, avgSeconds: 2 })
  })

  it('counts calls that threw and tool calls that returned an error as failed', () => {
    const { usage } = createRepos(openDatabase(':memory:'))
    usage.record(1, call('a/b', { error: 'no tools' }))
    usage.markToolError(usage.record(1, call('a/b')))
    usage.record(1, call('a/b'))
    expect(usage.stats()[0]).toMatchObject({ decisions: 3, failed: 2 })
  })

  it('reports no cost for models whose provider never sent one', () => {
    const { usage } = createRepos(openDatabase(':memory:'))
    usage.record(1, call('m', { provider: 'ollama', usage: { inputTokens: 5 } }))
    expect(usage.stats()[0]).toMatchObject({ provider: 'ollama', cost: null })
    expect(usage.sessionCost(1)).toBeNull()
  })

  it('separates sessions from all time', () => {
    const { usage } = createRepos(openDatabase(':memory:'))
    usage.record(1, call('a/b', { usage: { cost: 0.1 } }))
    usage.record(1, call('a/b', { usage: { cost: 0.1 } }))
    usage.record(2, call('c/d', { kind: 'reflection', usage: { cost: 0.25 } }))
    expect(usage.stats(1).map((s) => s.model)).toEqual(['a/b'])
    expect(usage.stats().map((s) => s.model)).toEqual(['a/b', 'c/d'])
    expect(usage.sessionCost(1)).toBeCloseTo(0.2)
    expect(usage.sessionCost(2)).toBe(0.25)
  })
})
