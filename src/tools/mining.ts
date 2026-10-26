import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { goals, moveTo, nearestEntity, UnreachableError, Vec3, type Block } from '../lib/mc.ts'
import { defineTool, ToolError } from './types.ts'

/** Walk within reach of a block, equip the best tool and dig it. Returns false if the block was gone or changed before digging. */
export async function digBlock(bot: Bot, block: Block, signal: AbortSignal): Promise<boolean> {
  await moveTo(bot, new goals.GoalLookAtBlock(block.position, bot.world), signal)
  const current = bot.blockAt(block.position)
  if (!current || current.name !== block.name) return false
  const tool = bot.pathfinder.bestHarvestTool(current)
  if (tool) await bot.equip(tool, 'hand')
  if (!current.canHarvest(bot.heldItem?.type ?? null)) throw new ToolError(`${current.name} needs a better tool to drop anything`)
  signal.throwIfAborted()
  const onAbort = () => bot.stopDigging()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await bot.dig(current, true)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  signal.throwIfAborted()
  return true
}

/** Item entities spawn a tick or so after a block breaks. */
const DROP_SPAWN_DELAY_MS = 250

/** Walk over dropped items within `radius`; returns how many item stacks were picked up. */
export async function collectNearbyDrops(bot: Bot, signal: AbortSignal, radius: number): Promise<number> {
  const unreachable = new Set<number>()
  let collected = 0
  for (let attempt = 0; attempt < 30; attempt++) {
    const drop = nearestEntity(bot, (e) => e.name === 'item' && !unreachable.has(e.id), radius)
    if (!drop) break
    try {
      await moveTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), signal)
      await sleep(300, undefined, { signal })
    } catch (err) {
      if (signal.aborted) throw signal.reason
    }
    if (bot.entities[drop.id]) unreachable.add(drop.id)
    else collected++
  }
  return collected
}

export const mine = defineTool({
  name: 'mine',
  description: 'Find, walk to and dig blocks of one type, then pick up the drops. Equips the best tool automatically.',
  schema: z.object({ block_type: z.string(), count: z.number().int().min(1).max(64).default(1) }),
  timeoutMs: 300_000,
  run: async ({ block_type, count }, { bot, signal }) => {
    const def = bot.registry.blocksByName[block_type]
    const item = bot.registry.itemsByName[block_type]
    if (!def && !item) throw new ToolError(`unknown block or item "${block_type}"`)

    const mineMatching = async (ids: number[], limit: number): Promise<Map<string, number>> => {
      const minedNames = new Map<string, number>()
      const skipped = new Set<string>()
      let mined = 0
      while (mined < limit && skipped.size < 5) {
        const block = bot.findBlock({ matching: ids, maxDistance: 64, useExtraInfo: (b) => !skipped.has(b.position.toString()) })
        if (!block) break
        try {
          if (await digBlock(bot, block, signal)) {
            mined++
            minedNames.set(block.name, (minedNames.get(block.name) ?? 0) + 1)
            await sleep(DROP_SPAWN_DELAY_MS, undefined, { signal })
            await collectNearbyDrops(bot, signal, 6)
          } else {
            skipped.add(block.position.toString())
          }
        } catch (err) {
          if (signal.aborted) throw err
          if (err instanceof UnreachableError) {
            skipped.add(block.position.toString())
            continue
          }
          if (err instanceof ToolError) throw new ToolError(`${err.message} (mined ${mined} so far)`)
          skipped.add(block.position.toString())
        }
      }
      return minedNames
    }

    if (def) {
      const minedNames = await mineMatching([def.id], count)
      const mined = [...minedNames.values()].reduce((a, b) => a + b, 0)
      if (mined > 0) return `mined ${mined}/${count} ${block_type}`
    }

    // Not a block name, or none nearby: the model may have named an item (cobblestone, raw_iron, coal), so mine blocks that drop it.
    const candidates = item ? blocksDropping(bot, item.id).filter((b) => b.name !== block_type) : []
    if (candidates.length === 0) throw new ToolError(`no reachable ${block_type} within 64 blocks`)
    const minedNames = await mineMatching(candidates.map((b) => b.id), count)
    const mined = [...minedNames.values()].reduce((a, b) => a + b, 0)
    if (mined === 0) {
      throw new ToolError(`no reachable ${block_type} within 64 blocks; it drops from: ${candidates.map((b) => b.name).join(', ')}`)
    }
    return `mined ${mined} ${[...minedNames.keys()].join(', ')} (drops ${block_type})`
  },
})

/** Blocks whose drops include the given item id (minecraft-data stores drops as item ids). */
function blocksDropping(bot: Bot, itemId: number) {
  return bot.registry.blocksArray.filter((b) => b.drops.includes(itemId))
}

export const breakBlock = defineTool({
  name: 'break_block',
  description: 'Dig the block at specific coordinates and pick up its drop.',
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  run: async ({ x, y, z }, { bot, signal }) => {
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.boundingBox === 'empty') throw new ToolError(`no solid block at ${x} ${y} ${z}`)
    if (!(await digBlock(bot, block, signal))) throw new ToolError(`${block.name} at ${x} ${y} ${z} changed before it could be dug`)
    await sleep(DROP_SPAWN_DELAY_MS, undefined, { signal })
    await collectNearbyDrops(bot, signal, 5)
    return `broke ${block.name} at ${x} ${y} ${z}`
  },
})
