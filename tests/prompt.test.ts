import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../src/agent/prompt.ts'

describe('buildUserPrompt', () => {
  it('marks empty sections and omits the chat section when nobody spoke', () => {
    const text = buildUserPrompt({ snapshot: { health: 20 }, goal: null, memory: {}, skills: [], history: [], chat: [] })
    expect(text).toContain('## Situation\n{"health":20}')
    expect(text).toContain('## Goal\n(none — choose one with set_goal)')
    expect(text).toContain('## Memory\n(none)')
    expect(text).not.toContain('## New chat')
    expect(text.trim().endsWith('Choose your next action: exactly one tool call.')).toBe(true)
  })

  it('lists memory, skills, history and new chat', () => {
    const text = buildUserPrompt({
      snapshot: {},
      goal: 'craft a stone pickaxe',
      memory: { base: '10 64 -20' },
      skills: [{ name: 'chop', description: 'chop trees', code: '', successes: 3, failures: 1 }],
      history: [{ id: 1, kind: 'action', content: 'mine {"block_type":"oak_log"} → ok: mined 1', created_at: '' }],
      chat: ['<Steve> hi'],
    })
    expect(text).toContain('## Goal\ncraft a stone pickaxe')
    expect(text).toContain('- base: 10 64 -20')
    expect(text).toContain('- chop — chop trees (3 ok, 1 failed)')
    expect(text).toContain('- [action] mine {"block_type":"oak_log"} → ok: mined 1')
    expect(text).toContain('## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n<Steve> hi')
  })
})

describe('buildSystemPrompt', () => {
  it('names the bot and explains skills', () => {
    const text = buildSystemPrompt('Mindy')
    expect(text).toContain('You are Mindy')
    expect(text).toContain('await tools.')
    expect(text).toContain('mine stone → cobblestone, iron_ore → raw_iron, coal_ore → coal, oak_log → oak_log.')
    expect(text).toContain('fix a broken skill with revise_skill')
    expect(text).toContain('explore in long hops (50+ blocks) only when nothing useful is near.')
  })
})
