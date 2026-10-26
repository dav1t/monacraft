import { createRequire } from 'node:module'

/** The parts of minecraft-data (mineflayer's `bot.registry`) the planner reads. */
export interface McItem {
  id: number
  name: string
}

export interface McBlock {
  id: number
  name: string
  material?: string
  harvestTools?: Record<string, boolean>
  drops: unknown[]
}

export interface McData {
  items: Record<number, McItem>
  itemsByName: Record<string, McItem>
  blocksByName: Record<string, McBlock>
  blocksArray: McBlock[]
  recipes: Record<number, unknown[]>
}

// prismarine-* are mineflayer's dependencies; pnpm does not hoist them, so resolve them from mineflayer's folder.
const fromHere = createRequire(import.meta.url)
const fromMineflayer = createRequire(fromHere.resolve('mineflayer'))

/** The registry for a Minecraft version, as `bot.registry` would be (used by tests and offline planning). */
export function loadRegistry(version: string): McData {
  return fromMineflayer('prismarine-registry')(version) as McData
}

interface DiggableBlock {
  digTime(heldItemType: number | null, creative: boolean, inWater: boolean, notOnGround: boolean, enchantments?: unknown[], effects?: unknown): number
}
type BlockClass = { fromStateId(stateId: number, biomeId: number): DiggableBlock }

const blockClasses = new WeakMap<McData, BlockClass>()
const digTimes = new Map<string, number>()

/** Milliseconds to dig a block on the ground with a tool (null = by hand), from prismarine-block. */
export function digTime(data: McData, blockName: string, toolName: string | null): number {
  const key = `${blockName}|${toolName}`
  const cached = digTimes.get(key)
  if (cached !== undefined) return cached
  const block = data.blocksByName[blockName] as (McBlock & { defaultState?: number; minStateId?: number }) | undefined
  if (!block) return 1_000
  let Block = blockClasses.get(data)
  if (!Block) {
    Block = fromMineflayer('prismarine-block')(data) as BlockClass
    blockClasses.set(data, Block)
  }
  const toolId = toolName ? (data.itemsByName[toolName]?.id ?? null) : null
  let ms: number
  try {
    ms = Block.fromStateId(block.defaultState ?? block.minStateId ?? 0, 0).digTime(toolId, false, false, false, [], {})
  } catch {
    ms = 1_000
  }
  if (!Number.isFinite(ms)) ms = 60_000 // unbreakable
  digTimes.set(key, ms)
  return ms
}

/** An item id inside a recipe: a number, [id, metadata] or { id, count }. */
export function recipeItemId(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return typeof value[0] === 'number' ? value[0] : null
  if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number') return (value as { id: number }).id
  return null
}

export function recipeResult(value: unknown): { id: number; count: number } | null {
  const id = recipeItemId(value)
  if (id === null) return null
  const count = typeof value === 'object' && value !== null && !Array.isArray(value) ? ((value as { count?: number }).count ?? 1) : 1
  return { id, count }
}

/** Item ids a block drops (minecraft-data stores drops as ids or { drop } objects). */
export function blockDrops(block: McBlock): number[] {
  return block.drops.flatMap((d) => {
    if (typeof d === 'number') return [d]
    const drop = typeof d === 'object' && d !== null ? (d as { drop?: unknown }).drop : undefined
    const id = recipeItemId(drop)
    return id === null ? [] : [id]
  })
}
