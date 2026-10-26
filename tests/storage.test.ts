import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { buildUserPrompt } from '../src/agent/prompt.ts'
import { describeContainer } from '../src/db/containers.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { countInventory, countOwned, readEquipped } from '../src/sensors/world.ts'

describe('equipped items', () => {
  // Window slots: 5-8 armor (head to feet), 36-44 hotbar, 45 off-hand.
  const slots: ({ name: string; count: number } | null)[] = Array(46).fill(null)
  slots[5] = { name: 'iron_helmet', count: 1 }
  slots[45] = { name: 'shield', count: 1 }
  const bot = {
    heldItem: { name: 'stone_pickaxe' },
    inventory: { slots, items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_log', count: 3 }] },
  } as unknown as Bot

  it('reports what is in hand and worn', () => {
    expect(readEquipped(bot)).toEqual({ hand: 'stone_pickaxe', head: 'iron_helmet', off_hand: 'shield' })
  })

  it('counts worn items as owned but not as carried', () => {
    expect(countInventory(bot)).toEqual({ stone_pickaxe: 1, oak_log: 3 })
    expect(countOwned(bot)).toEqual({ stone_pickaxe: 1, oak_log: 3, iron_helmet: 1, shield: 1 })
  })
})

describe('containers', () => {
  it('remembers what each chest holds and shows it in the prompt', () => {
    const repos = createRepos(openDatabase(':memory:'))
    repos.containers.save({ block: 'chest', x: 1, y: 64, z: 2, items: { oak_log: 12, cobblestone: 64 } })
    repos.containers.save({ block: 'chest', x: 1, y: 64, z: 2, items: { cobblestone: 30 } })
    repos.containers.save({ block: 'barrel', x: 5, y: 64, z: 2, items: {} })
    expect(repos.containers.get(1, 64, 2)?.items).toEqual({ cobblestone: 30 })
    const lines = repos.containers.list().map(describeContainer)
    expect(lines).toContain('chest at 1 64 2: cobblestone x30')
    expect(lines).toContain('barrel at 5 64 2: empty')
    const text = buildUserPrompt({ snapshot: {}, goal: null, memory: [], skills: [], history: [], chat: [], containers: lines })
    expect(text).toContain('## Stored')
    expect(text).toContain('- chest at 1 64 2: cobblestone x30')
    expect(repos.containers.delete(1, 64, 2)).toBe(true)
    expect(repos.containers.list()).toHaveLength(1)
  })
})
