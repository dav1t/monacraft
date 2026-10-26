import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'

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
