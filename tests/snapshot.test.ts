import { describe, expect, it } from 'vitest'
import { facingLabel, formatSnapshot, summarizeEntities, timeLabel, topCounts, type WorldState } from '../src/sensors/snapshot.ts'

describe('timeLabel', () => {
  it('maps day ticks to phases', () => {
    expect([0, 6000, 12500, 18000, 23500, 30000].map(timeLabel)).toEqual(['sunrise', 'day', 'dusk', 'night', 'dawn', 'day'])
  })
})

describe('facingLabel', () => {
  it('converts mineflayer yaw (0 = north, counter-clockwise) to a compass direction', () => {
    expect([0, Math.PI / 2, Math.PI, -Math.PI / 2, 2 * Math.PI].map(facingLabel)).toEqual(['north', 'west', 'south', 'east', 'north'])
  })
})

describe('summarizeEntities', () => {
  it('groups by label, hostile first, then nearest first', () => {
    expect(
      summarizeEntities([
        { label: 'cow', distance: 12.4, hostile: false },
        { label: 'zombie', distance: 9, hostile: true },
        { label: 'zombie', distance: 7.2, hostile: true },
        { label: 'player:Steve', distance: 3, hostile: false },
      ]),
    ).toEqual(['zombie x2 (hostile, nearest 7m)', 'player:Steve (nearest 3m)', 'cow (nearest 12m)'])
  })
})

describe('topCounts', () => {
  it('keeps the largest counts in descending order', () => {
    expect(topCounts({ a: 1, b: 5, c: 3 }, 2)).toEqual({ b: 5, c: 3 })
  })
})

describe('formatSnapshot', () => {
  it('produces the compact JSON the LLM sees', () => {
    const state: WorldState = {
      health: 18, food: 12, xpLevel: 3,
      position: [120, 64, -44], yaw: Math.PI,
      biome: 'forest', timeOfDay: 12500, raining: false,
      held: 'stone_pickaxe', armor: ['leather_helmet'], cursorBlock: 'oak_log',
      inventory: { oak_log: 12, stone_pickaxe: 1 },
      entities: [{ label: 'cow', distance: 12, hostile: false }],
      blocks: { grass_block: 20, oak_log: 8, stone: 5 },
    }
    expect(formatSnapshot(state)).toEqual({
      health: 18, food: 12, xp_level: 3,
      position: [120, 64, -44], facing: 'south', biome: 'forest',
      time: 'dusk', weather: 'clear',
      held: 'stone_pickaxe', armor: ['leather_helmet'], looking_at: 'oak_log',
      inventory: { oak_log: 12, stone_pickaxe: 1 },
      nearby_entities: ['cow (nearest 12m)'],
      nearby_blocks: { grass_block: 20, oak_log: 8, stone: 5 },
    })
  })
})
