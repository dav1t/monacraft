import { z } from 'zod'
import { describeEntity, formatPos, Vec3 } from '../lib/mc.ts'
import { topCounts } from '../sensors/snapshot.ts'
import { countVisibleBlocks } from '../sensors/world.ts'
import { defineTool, ToolError } from './types.ts'

export const scanBlocks = defineTool({
  name: 'scan_blocks',
  description: 'Count the visible block types around you.',
  schema: z.object({ radius: z.number().int().min(2).max(12).default(8) }),
  run: async ({ radius }, { bot }) => JSON.stringify(topCounts(countVisibleBlocks(bot, radius), 30)),
})

export const findBlocks = defineTool({
  name: 'find_blocks',
  description: 'Find the nearest blocks of a type; returns coordinates, nearest first.',
  schema: z.object({
    block_type: z.string(),
    count: z.number().int().min(1).max(20).default(5),
    max_distance: z.number().int().min(8).max(128).default(64),
  }),
  run: async ({ block_type, count, max_distance }, { bot }) => {
    const def = bot.registry.blocksByName[block_type]
    if (!def) throw new ToolError(`unknown block "${block_type}"`)
    const me = bot.entity.position
    const found = bot
      .findBlocks({ matching: def.id, maxDistance: max_distance, count })
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    if (found.length === 0) return `no ${block_type} within ${max_distance} blocks`
    return found.map((p) => `${formatPos(p)} (${Math.round(p.distanceTo(me))}m)`).join('; ')
  },
})

export const findEntities = defineTool({
  name: 'find_entities',
  description: 'List entities within 32 blocks, optionally only one type (e.g. cow, zombie, player).',
  schema: z.object({ type: z.string().optional() }),
  run: async ({ type }, { bot }) => {
    const me = bot.entity.position
    const found = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= 32)
      .filter((e) => !type || e.name === type || e.type === type || e.username === type)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
      .slice(0, 15)
    if (found.length === 0) return type ? `no ${type} within 32 blocks` : 'nothing within 32 blocks'
    return found.map((e) => `${describeEntity(e)} at ${formatPos(e.position)} (${Math.round(e.position.distanceTo(me))}m)`).join('; ')
  },
})

export const lookAt = defineTool({
  name: 'look_at',
  description: 'Tell which block is at given coordinates.',
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  run: async ({ x, y, z }, { bot }) => {
    const block = bot.blockAt(new Vec3(x, y, z))
    return block ? `${block.name} at ${x} ${y} ${z}` : `${x} ${y} ${z} is not loaded`
  },
})
