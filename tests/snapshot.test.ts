import { describe, expect, it } from 'vitest'
import { compass, relative } from '../src/sensors/geometry.ts'
import { facingLabel, formatNotable, formatSnapshot, groupNotable, summarizeEntities, timeLabel, topCounts, type WorldState } from '../src/sensors/snapshot.ts'

describe('compass and relative', () => {
  it('names directions the Minecraft way (north = -z, east = +x)', () => {
    expect([compass(0, -5), compass(5, -5), compass(5, 0), compass(3, 3), compass(0, 5), compass(-4, 4), compass(-5, 0), compass(-2, -2)]).toEqual([
      'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW',
    ])
  })

  it('describes where something is from the bot, marking big height differences', () => {
    expect(relative({ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: -4 })).toEqual({ distance: 5, direction: 'NE' })
    expect(relative({ x: 0, y: 64, z: 0 }, { x: 4, y: 59, z: 3 })).toEqual({ distance: 7, direction: 'SE, below' })
    expect(relative({ x: 0, y: 64, z: 0 }, { x: 0.2, y: 70, z: 0 })).toEqual({ distance: 6, direction: 'above' })
  })
})

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
        { label: 'cow', distance: 12.4, hostile: false, direction: 'W' },
        { label: 'zombie', distance: 9, hostile: true, direction: 'N' },
        { label: 'zombie', distance: 7.2, hostile: true, direction: 'NE', trend: 'approaching' },
        { label: 'player:Steve', distance: 3, hostile: false, direction: 'S, below' },
      ]),
    ).toEqual(['zombie x2 (hostile, nearest 7m NE, approaching)', 'player:Steve (nearest 3m S, below)', 'cow (nearest 12m W)'])
  })
})

describe('groupNotable', () => {
  it('counts each kind and keeps the nearest, measured from where the bot is now', () => {
    const blocks = [
      { name: 'oak_log', position: { x: 10, y: 64, z: 0 } },
      { name: 'oak_log', position: { x: 3, y: 64, z: 4 } },
      { name: 'iron_ore', position: { x: 0, y: 58, z: -5 } },
    ]
    expect(groupNotable(blocks, { x: 0.5, y: 64, z: 0.5 })).toEqual({
      oak_log: { count: 2, nearest: [3, 64, 4], distance: 4, direction: 'SE' },
      iron_ore: { count: 1, nearest: [0, 58, -5], distance: 8, direction: 'N, below' },
    })
  })
})

describe('formatNotable', () => {
  it('lists the nearest of each useful block with its position, nearest first, capped', () => {
    expect(
      formatNotable(
        {
          oak_log: { count: 9, nearest: [10, 64, 2], distance: 10, direction: 'E' },
          iron_ore: { count: 3, nearest: [14, 31, -8], distance: 5, direction: 'NE, below' },
          chest: { count: 1, nearest: [1, 64, 1], distance: 1, direction: 'SE' },
        },
        2,
      ),
    ).toEqual({ chest: 'nearest 1 64 1 (1m SE)', iron_ore: 'x3, nearest 14 31 -8 (5m NE, below)' })
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
      equipped: { hand: 'stone_pickaxe', head: 'leather_helmet' }, cursorBlock: 'oak_log',
      inventory: { oak_log: 12, stone_pickaxe: 1 },
      entities: [{ label: 'cow', distance: 12, hostile: false, direction: 'N' }],
      blocks: { grass_block: 20, oak_log: 8, stone: 5 },
      notable: { oak_log: { count: 8, nearest: [121, 64, -40], distance: 4, direction: 'S' } },
    }
    expect(formatSnapshot(state)).toEqual({
      health: 18, food: 12, xp_level: 3,
      position: [120, 64, -44], facing: 'south', biome: 'forest',
      time: 'dusk', weather: 'clear',
      equipped: { hand: 'stone_pickaxe', head: 'leather_helmet' }, looking_at: 'oak_log',
      inventory: { oak_log: 12, stone_pickaxe: 1 },
      nearby_entities: ['cow (nearest 12m N)'],
      nearby_blocks: { grass_block: 20, oak_log: 8, stone: 5 },
      notable_blocks: { oak_log: 'x8, nearest 121 64 -40 (4m S)' },
    })
  })
})
