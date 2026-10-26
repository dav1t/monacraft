import { describe, expect, it } from 'vitest'
import { digTime, loadRegistry } from '../src/planning/data.ts'
import { describeStep, formatPlan, planItem, recipesFor, type Plan } from '../src/planning/planner.ts'

const data = loadRegistry('1.21.11')
const none = { craftingTable: false, furnace: false }
const lines = (plan: Plan): string[] => plan.steps.map(describeStep)

describe('recipesFor', () => {
  it('merges wood variants into one recipe whose slots accept any planks', () => {
    const recipes = recipesFor(data, 'stick')
    const stick = recipes.find((r) => r.slots[0]?.alts.includes('oak_planks'))
    expect(recipes.length).toBeLessThanOrEqual(2) // planks, and bamboo
    expect(stick).toMatchObject({ makes: 4, table: false })
    expect(stick?.slots[0]?.alts).toContain('birch_planks')
    expect(stick?.slots[0]?.alts[0]).toBe('oak_planks')
  })
})

describe('digTime', () => {
  it('uses real dig times', () => {
    expect(digTime(data, 'oak_log', null)).toBe(3000)
    expect(digTime(data, 'oak_log', 'wooden_axe')).toBe(1500)
    expect(digTime(data, 'oak_log', 'stone_axe')).toBe(750)
  })
})

describe('planItem', () => {
  it('plans a stone pickaxe from nothing in dependency order', () => {
    const plan = planItem(data, 'stone_pickaxe', 1, {}, none)
    expect(lines(plan)).toEqual([
      'mine oak_log x3',
      'craft oak_planks x12 (from 3 oak_log)',
      'craft stick x4 (from 2 oak_planks)',
      'craft crafting_table x1 (from 4 oak_planks)',
      'place crafting_table nearby',
      'craft wooden_pickaxe x1 (from 3 oak_planks, 2 stick, at a crafting_table)',
      'mine stone x3 (needs wooden_pickaxe) → cobblestone',
      'craft stone_pickaxe x1 (from 3 cobblestone, 2 stick, at a crafting_table)',
    ])
    expect(plan.raw).toEqual({ oak_log: 3, cobblestone: 3 })
    expect(plan.tools).toEqual(['wooden_pickaxe'])
    expect(plan.seconds).toBeGreaterThan(30)
  })

  it('subtracts the inventory and a known crafting table', () => {
    const plan = planItem(data, 'stone_pickaxe', 1, { oak_planks: 3, stick: 2, wooden_pickaxe: 1 }, { craftingTable: true, furnace: false })
    expect(lines(plan)).toEqual([
      'mine stone x3 (needs wooden_pickaxe) → cobblestone',
      'craft stone_pickaxe x1 (from 3 cobblestone, 2 stick, at a crafting_table)',
    ])
    expect(plan.have).toMatchObject({ stick: 2, wooden_pickaxe: 1 })
    expect(formatPlan(plan)).toContain('raw needs: 3 cobblestone')
  })

  it('needs a furnace, fuel and a stone pickaxe for an iron pickaxe', () => {
    const plan = planItem(data, 'iron_pickaxe', 1, {}, none)
    const text = lines(plan)
    const at = (prefix: string): number => text.findIndex((l) => l.startsWith(prefix))
    expect(at('craft stone_pickaxe')).toBeLessThan(at('mine iron_ore x3 (needs stone_pickaxe)'))
    expect(at('place furnace')).toBeLessThan(at('smelt raw_iron x3 → iron_ingot'))
    expect(text.at(-1)).toMatch(/^craft iron_pickaxe x1 \(from 3 iron_ingot, 2 stick/)
    expect(plan.tools).toEqual(['wooden_pickaxe', 'stone_pickaxe'])
  })

  it('uses whatever wood the bot has', () => {
    const plan = planItem(data, 'crafting_table', 1, { birch_log: 1 }, none)
    expect(lines(plan)).toEqual(['craft birch_planks x4 (from 1 birch_log)', 'craft crafting_table x1 (from 4 birch_planks)'])
  })

  it('advises making an axe first for a big wood haul', () => {
    const plan = planItem(data, 'oak_planks', 120, {}, none)
    expect(plan.tools).toEqual(['wooden_axe'])
    expect(plan.notes[0]).toMatch(/^make wooden_axe first: 30 oak_log 90 s → 45 s, wooden_axe costs ~\d+ s$/)
    expect(lines(plan)).toContain('craft wooden_axe x1 (from 3 oak_planks, 2 stick, at a crafting_table)')
    expect(lines(plan).some((l) => l.startsWith('mine oak_log x30 (with wooden_axe'))).toBe(true)
  })

  it('does not advise a tool for a few blocks', () => {
    expect(planItem(data, 'oak_planks', 8, {}, none).tools).toEqual([])
  })

  it('gathers natural resources instead of unpacking storage blocks, and hunts mob drops', () => {
    expect(lines(planItem(data, 'coal', 3, { wooden_pickaxe: 1 }, none))).toEqual(['mine coal_ore x3 (needs wooden_pickaxe) → coal'])
    expect(lines(planItem(data, 'string', 2, {}, none))).toEqual(['get string x2 (from spider)'])
  })

  it('returns an empty plan when the item is already there, and rejects unknown items', () => {
    expect(formatPlan(planItem(data, 'stick', 2, { stick: 5 }, none))).toBe('stick x2 — about 0 s\nyou already have it')
    expect(() => planItem(data, 'unobtainium', 1, {}, none)).toThrow(/unknown item/)
  })
})
