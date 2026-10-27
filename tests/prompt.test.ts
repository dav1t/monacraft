import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserPrompt, CAPS, pickSkills, type PromptInput } from '../src/agent/prompt.ts'
import type { PlanTemplate, Skill } from '../src/db/repos.ts'

const base: PromptInput = { snapshot: {}, goal: null, memory: [], skills: [], history: [], chat: [] }
const skill = (name: string, description: string, successes = 0, failures = 0): Skill => ({ name, description, code: '', successes, failures })

describe('buildUserPrompt', () => {
  it('marks empty sections and omits the chat section when nobody spoke', () => {
    const text = buildUserPrompt({ ...base, snapshot: { health: 20 } })
    expect(text).toContain('## Situation\n{"health":20}')
    expect(text).toContain('## Goal\n(none — choose one with set_goal)')
    expect(text).toContain('## Memory\n(none)')
    expect(text).not.toContain('## New chat')
    expect(text).not.toContain('## Yesterday')
    expect(text).not.toContain('## Lessons')
    expect(text).not.toContain('## Plan templates')
    expect(text.trim().endsWith('Choose your next action: exactly one tool call.')).toBe(true)
  })

  it('lists the goal tree, memory, skills, history and new chat', () => {
    const text = buildUserPrompt({
      ...base,
      goal: '## Goal: craft a stone pickaxe\n▶ get stone_pickaxe',
      memory: [{ key: 'base', value: '10 64 -20' }],
      skills: [skill('chop', 'chop trees', 3, 1)],
      history: [{ id: 1, kind: 'action', content: 'mine {"block_type":"oak_log"} → ok: mined 1', created_at: '' }],
      chat: ['<Steve> hi'],
    })
    expect(text).toContain('## Goal: craft a stone pickaxe\n▶ get stone_pickaxe')
    expect(text).toContain('- base: 10 64 -20')
    expect(text).toContain('- chop — chop trees (3 ok, 1 failed)')
    expect(text).toContain('- [action] mine {"block_type":"oak_log"} → ok: mined 1')
    expect(text).toContain('## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n<Steve> hi')
  })

  it('caps every growing section', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i)
    const template: PlanTemplate = { name: 't', kind: 'goal', pattern: 't', titles: ['a', 'b'], uses: 0, successes: 1, failures: 0, flagged: false, updated_at: '' }
    const text = buildUserPrompt({
      ...base,
      journal: 'j'.repeat(2000),
      lessons: many(15).map((i) => `lesson ${i}`),
      memory: many(30).map((i) => ({ key: `k${i}`, value: 'v' })),
      skills: many(12).map((i) => skill(`s${i}`, 'x')),
      history: many(CAPS.history + 5).map((i) => ({ id: i, kind: 'event' as const, content: `e${i}`, created_at: '' })),
      templates: [template, template, template, template, template],
    })
    expect(text.match(/## Yesterday\n(j+)/)?.[1]?.length).toBe(CAPS.journal - 1)
    expect(text).not.toContain('lesson 4\n')
    expect(text).toContain('- lesson 14')
    expect(text).toContain('- k19: v')
    expect(text).not.toContain('- k20: v')
    expect(text).toContain('(10 older facts not shown)')
    expect(text).toContain('(4 more skills not shown)')
    expect(text).not.toContain('[event] e4\n')
    expect(text).toContain(`- [event] e${CAPS.history + 4}`)
    expect(text.match(/^- t: /gm)).toHaveLength(CAPS.templates)
  })
})

describe('buildUserPrompt order', () => {
  it('puts what rarely changes first and what changes every step last, so the model cache is reused', () => {
    const text = buildUserPrompt({
      ...base,
      revelations: ['r'],
      lessons: ['l'],
      journal: 'j',
      memory: [{ key: 'k', value: 'v' }],
      structures: ['s'],
      skills: [skill('chop', 'c')],
      goal: '## Goal: g',
      history: [{ id: 1, kind: 'event', content: 'e', created_at: '' }],
      chat: ['<Steve> hi'],
    })
    const order = [...text.matchAll(/^## (\w+)/gm)].map((m) => m[1])
    expect(order).toEqual(['Revelations', 'Lessons', 'Yesterday', 'Memory', 'Built', 'Skills', 'Goal', 'Situation', 'Recent', 'New'])
  })
})

describe('pickSkills', () => {
  it('prefers skills that match the focus, then reliable ones', () => {
    const skills = [skill('build_hut', 'build a hut', 9, 0), skill('chop_trees', 'collect oak logs', 1, 3), skill('dig', 'dig down', 5, 0)]
    expect(pickSkills(skills, 'get oak_log x5', 2).map((s) => s.name)).toEqual(['chop_trees', 'build_hut'])
  })
})

describe('buildSystemPrompt', () => {
  it('names the bot and explains skills, plans and sleep', () => {
    const text = buildSystemPrompt('Mindy')
    expect(text).toContain('You are Mindy')
    expect(text).toContain('await tools.')
    expect(text).toContain('mine stone → cobblestone, iron_ore → raw_iron, coal_ore → coal, oak_log → oak_log.')
    expect(text).toContain('fix a broken skill with revise_skill')
    expect(text).toContain('plan_goal')
    expect(text).toContain('follow the plan\'s tool advice')
    expect(text).toContain('sleep in a bed')
  })
})

describe('buildUserPrompt revelations', () => {
  it('puts revelations first and omits the section when there are none', () => {
    const text = buildUserPrompt({ ...base, revelations: ['craft planks from logs'] })
    expect(text.startsWith('## Revelations — from your creator, highest priority\n- craft planks from logs\n\n## Memory')).toBe(true)
    expect(buildUserPrompt({ ...base, revelations: [] })).not.toContain('Revelations')
  })
})
