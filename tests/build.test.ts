import type { Bot } from 'mineflayer'
import { describe, expect, it, vi } from 'vitest'
import { facingFromYaw, normalizeSize, originInFront, shapeBlocks, toWorld } from '../src/building/shapes.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos, type Repos } from '../src/db/repos.ts'
import { loadRegistry } from '../src/planning/data.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { ToolError } from '../src/tools/types.ts'

// Placing needs a real server; the fake world below decides which placements work.
const placeAt = vi.hoisted(() => vi.fn())
vi.mock('../src/tools/building.ts', () => ({ placeAt }))
vi.mock('../src/lib/mc.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/mc.ts')>()),
  Movements: class {
    canDig = true
  },
}))
const { build } = await import('../src/tools/build.ts')
const { recall } = await import('../src/tools/recall.ts')

describe('shapes', () => {
  it('builds a shelter of walls with a 2-high door gap and a roof', () => {
    const size = normalizeSize('shelter', {})
    expect(size).toEqual({ width: 5, depth: 5, height: 3 })
    const blocks = shapeBlocks('shelter', size)
    expect(blocks).toHaveLength(16 * 3 - 2 + 25)
    expect(blocks.some((b) => b.x === 2 && b.z === 0 && b.y < 2)).toBe(false)
    expect(blocks.some((b) => b.x === 2 && b.z === 0 && b.y === 2)).toBe(true)
    // Bottom layer first; the roof from the edge inwards (its centre last).
    expect(blocks.map((b) => b.y)).toEqual([...blocks.map((b) => b.y)].sort((a, b) => a - b))
    expect(blocks.at(-1)).toEqual({ x: 2, y: 3, z: 2 })
  })

  it('clamps sizes and fixes what a shape does not have', () => {
    expect(normalizeSize('wall', { width: 40, depth: 7, height: 0 })).toEqual({ width: 16, depth: 1, height: 1 })
    expect(normalizeSize('pillar', { width: 3, height: 4 })).toEqual({ width: 1, depth: 1, height: 4 })
    expect(shapeBlocks('floor', { width: 3, depth: 3, height: 1 }).at(-1)).toEqual({ x: 1, y: 0, z: 1 })
  })

  it('places structures in front of the bot, whichever way it faces', () => {
    expect(facingFromYaw(0)).toBe('north')
    expect(facingFromYaw(Math.PI / 2)).toBe('west')
    expect(facingFromYaw(-Math.PI / 2)).toBe('east')
    const origin = originInFront({ x: 10, y: 64, z: 10 }, 'north', 5)
    expect(origin).toEqual({ x: 8, y: 64, z: 8 })
    // Facing north: right is east (+x), away is north (-z).
    expect(toWorld(origin, 'north', { x: 4, y: 0, z: 4 })).toEqual({ x: 12, y: 64, z: 4 })
    expect(toWorld({ x: 0, y: 0, z: 0 }, 'east', { x: 1, y: 0, z: 2 })).toEqual({ x: 2, y: 0, z: 1 })
  })
})

const data = loadRegistry('1.21.11')

/** A flat world (solid below y=64) with an inventory; placeAt fills the target unless `blocked` says no. */
function fakeWorld(planks: number, blocked: (p: { x: number; y: number; z: number }) => boolean = () => false) {
  const solid = new Set<string>()
  const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`
  let count = planks
  const setMovements = vi.fn()
  const bot = {
    registry: data,
    entity: { yaw: 0, position: { floored: () => ({ x: 10, y: 64, z: 10 }) } },
    blockAt: (p: { x: number; y: number; z: number }) => ({ boundingBox: p.y < 64 || solid.has(key(p)) ? 'block' : 'empty', name: 'x' }),
    inventory: { count: () => count },
    pathfinder: { movements: 'original', setMovements },
  }
  placeAt.mockReset()
  placeAt.mockImplementation(async (_bot: unknown, _block: string, p: { x: number; y: number; z: number }) => {
    if (blocked(p)) throw new ToolError('nothing solid next to it')
    solid.add(key(p))
    count--
  })
  const repos = createRepos(openDatabase(':memory:'))
  const ctx = { bot: bot as unknown as Bot, repos, log: () => {}, signal: new AbortController().signal }
  const registry = new ToolRegistry().register(build, recall)
  return { repos, run: (tool: string, args: unknown) => registry.run(tool, args, ctx), setMovements, solid }
}

describe('build', () => {
  it('builds a whole shelter, records it, and does not let the pathfinder dig meanwhile', async () => {
    const { repos, run, setMovements } = fakeWorld(80)
    expect(await run('build', { shape: 'shelter', block: 'oak_planks' })).toBe(
      'built shelter: shelter 5x5x3 of oak_planks at 8 64 8, door on the south side (complete)',
    )
    expect(placeAt).toHaveBeenCalledTimes(71)
    expect(repos.structures.get('shelter')).toMatchObject({ status: 'complete', placed: 71, total: 71, facing: 'north' })
    expect(setMovements.mock.calls[0]?.[0]).toMatchObject({ canDig: false })
    expect(setMovements).toHaveBeenLastCalledWith('original')
    expect(await run('build', { shape: 'shelter', block: 'oak_planks' })).toMatch(/^shelter is already built/)
  })

  it('refuses up front when blocks are missing, saying how many to get', async () => {
    const { run } = fakeWorld(35)
    await expect(run('build', { shape: 'shelter', block: 'oak_planks' })).rejects.toThrow(
      'shelter needs 71 more oak_planks (you have 35) — get 36 more first, e.g. plan_item { item: "oak_planks", count: 36 }',
    )
    expect(placeAt).not.toHaveBeenCalled()
    await expect(run('build', { shape: 'wall', block: 'not_a_block' })).rejects.toThrow(/not a placeable block/)
  })

  it('keeps an unfinished structure and finishes it on the next call with the same name', async () => {
    let stuck = true
    const { repos, run } = fakeWorld(80, (p) => stuck && p.y === 67)
    expect(await run('build', { shape: 'shelter', block: 'oak_planks', name: 'hut' })).toMatch(
      /^hut: shelter 5x5x3 of oak_planks at 8 64 8, door on the south side \(unfinished, 46\/71 blocks\) — some blocks could not be placed\. First problem: nothing solid/,
    )
    stuck = false
    expect(await run('build', { shape: 'shelter', block: 'oak_planks', name: 'hut' })).toMatch(/^built hut: .*\(complete\)$/)
    expect(repos.structures.get('hut')?.placed).toBe(71)
  })

  it('recall finds what was built, remembered and done long ago', async () => {
    const { repos, run } = fakeWorld(10)
    await run('build', { shape: 'pillar', block: 'oak_planks', height: 3, name: 'lookout' })
    repos.memory.set('furnace', '156 68 -1535')
    repos.history.add('action', 'place {"block_type":"furnace"} → ok: placed furnace at 156 68 -1535')
    for (let i = 0; i < 50; i++) repos.history.add('action', `mine stone ${i}`)
    const found = await run('recall', { query: 'furnace' })
    expect(found.split('\n')).toEqual([
      '[memory] furnace: 156 68 -1535',
      expect.stringMatching(/^\[history\] .* place \{"block_type":"furnace"\} → ok: placed furnace at 156 68 -1535$/),
    ])
    expect(await run('recall', { query: 'lookout pillar' })).toMatch(/^\[built\] lookout: pillar 3 high of oak_planks/)
    expect(await run('recall', { query: 'diamonds' })).toBe('nothing found about "diamonds"')
  })
})

describe('building goals', () => {
  async function goalSetup(repos: Repos) {
    const { GoalKeeper } = await import('../src/agent/goals.ts')
    const goals = new GoalKeeper(repos)
    goals.setGoal('establish base')
    goals.planGoal(['build a basic shelter', 'gather planks for the walls'])
    return goals
  }

  it('done is refused for a building sub-goal until a build completes, and a finished build ticks it off', async () => {
    const repos = createRepos(openDatabase(':memory:'))
    const goals = await goalSetup(repos)
    expect(() => goals.done('Built a basic shelter with oak planks.')).toThrow(/nothing has been built for "build a basic shelter" yet — use build/)
    repos.structures.save({ name: 'shelter', shape: 'shelter', block: 'oak_planks', x: 0, y: 64, z: 0, facing: 'north', width: 5, depth: 5, height: 3, total: 71, placed: 71, status: 'complete' })
    goals.afterAction('build', { shape: 'shelter' }, 'ok: built shelter: …')
    expect(goals.focus()).toBe('gather planks for the walls')
    // Not a building title, so done works as before.
    expect(goals.done()).toBe('sub-goal done: gather planks for the walls')
  })

  it('shows what stands in the prompt', async () => {
    const { buildUserPrompt } = await import('../src/agent/prompt.ts')
    const text = buildUserPrompt({ snapshot: {}, goal: null, memory: [], skills: [], history: [], chat: [], structures: ['shelter: shelter 5x5x3 of oak_planks at 0 64 0 (complete)'] })
    expect(text).toContain('## Built — what really stands\n- shelter: shelter 5x5x3 of oak_planks at 0 64 0 (complete)')
  })
})
