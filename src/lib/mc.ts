import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { ToolError } from '../tools/types.ts'

// Types of mineflayer's transitive packages, derived from Bot (pnpm doesn't hoist those packages).
export type Entity = Bot['entity']
export type Item = NonNullable<Bot['heldItem']>
export type Block = NonNullable<ReturnType<Bot['blockAt']>>
type Goal = import('mineflayer-pathfinder').goals.Goal

// vec3 is CommonJS and only exposes the class as a property of its default export.
const require = createRequire(import.meta.url)
export const Vec3: typeof import('vec3').Vec3 = require('vec3').Vec3
export type Vec3 = import('vec3').Vec3

export const { pathfinder, Movements, goals } = pathfinderPkg

/** The pathfinder could not get to the goal; callers that have alternatives (e.g. other blocks) may skip and try them. */
export class UnreachableError extends ToolError {
  override name = 'UnreachableError'
}

/** moveTo gives up when the bot moves less than STALL_DISTANCE blocks in STALL_MS. */
const STALL_DISTANCE = 1
const STALL_MS = 10_000

/** Pathfind to a goal; aborting the signal stops the bot. */
export async function moveTo(bot: Bot, goal: Goal, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  // setGoal(null) ends goto() immediately (GoalChanged). pathfinder.stop() only sets a flag that is honoured at the next path node and lingers if idle.
  const onAbort = () => bot.pathfinder.setGoal(null)
  signal.addEventListener('abort', onAbort, { once: true })
  // The pathfinder never gives up when the server keeps rejecting its moves: it replans the same path every few
  // seconds while the bot stands still. Give up once the bot has not moved for a while (digging or pillaring counts as progress).
  let anchor = bot.entity.position.clone()
  let lastProgress = Date.now()
  let stuckAt: string | null = null
  const watchdog = setInterval(() => {
    const here = bot.entity.position
    if (here.distanceTo(anchor) >= STALL_DISTANCE || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) {
      anchor = here.clone()
      lastProgress = Date.now()
    } else if (Date.now() - lastProgress >= STALL_MS) {
      stuckAt = formatPos(here)
      bot.pathfinder.setGoal(null)
    }
  }, 1_000)
  try {
    await bot.pathfinder.goto(goal)
  } catch (err) {
    if (signal.aborted) throw signal.reason
    bot.pathfinder.setGoal(null) // don't keep drifting toward the goal after reporting failure
    if (stuckAt) throw new UnreachableError(`stuck at ${stuckAt}: something blocks the way — try another route or direction`)
    throw new UnreachableError(`could not reach the target: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearInterval(watchdog)
    signal.removeEventListener('abort', onAbort)
  }
  if (signal.aborted) throw signal.reason
  // goto() also resolves when no path exists (its noPath listener sees an empty path), so verify arrival.
  // Same test the pathfinder itself uses for completion: isEnd on the floored position (or one block above).
  // Goal.isEnd is typed as taking a pathfinder Move, but every goal only reads x/y/z, so a Vec3 works (the pathfinder passes p.floored() itself).
  const here = bot.entity.position.floored() as unknown as Parameters<Goal['isEnd']>[0]
  const above = bot.entity.position.floored().offset(0, 1, 0) as unknown as typeof here
  if (!goal.isEnd(here) && !goal.isEnd(above)) {
    bot.pathfinder.setGoal(null)
    throw new UnreachableError('could not reach the target (no path found)')
  }
}

export function nearestEntity(bot: Bot, match: (entity: Entity) => boolean, maxDistance: number): Entity | null {
  let best: Entity | null = null
  let bestDistance = maxDistance
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !match(entity)) continue
    const distance = entity.position.distanceTo(bot.entity.position)
    if (distance <= bestDistance) {
      best = entity
      bestDistance = distance
    }
  }
  return best
}

export function describeEntity(entity: Entity): string {
  if (entity.type === 'player') return `player:${entity.username}`
  if (entity.name === 'item') return `dropped:${entity.getDroppedItem()?.name ?? 'item'}`
  return entity.name ?? 'unknown'
}

export function formatPos(pos: { x: number; y: number; z: number }): string {
  return `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`
}

/** Mobs mineflayer tags 'mob' (not 'hostile') on 1.21.x that still attack. */
const HOSTILE_MOBS = new Set(['slime', 'magma_cube', 'phantom', 'ghast', 'shulker', 'hoglin'])

export function isHostile(entity: Pick<Entity, 'type' | 'name'>): boolean {
  return entity.type === 'hostile' || HOSTILE_MOBS.has(entity.name ?? '')
}

/** Biome name at a position. block.biome.name is empty on 1.21.x, so resolve it through the registry by id. */
export function biomeAt(bot: Bot, pos: { x: number; y: number; z: number }): string {
  const biome = bot.blockAt(pos as Vec3)?.biome
  if (!biome) return 'unknown'
  return biome.name || bot.registry.biomes[biome.id]?.name || 'unknown'
}
