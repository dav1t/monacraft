import type { Bot, Chest } from 'mineflayer'
import { z } from 'zod'
import { describeContainer } from '../db/containers.ts'
import type { Repos } from '../db/repos.ts'
import { type Block, goals, moveTo, Vec3 } from '../lib/mc.ts'
import { errorMessage } from '../lib/text.ts'
import { defineTool, ToolError } from './types.ts'

const STORAGE = new Set(['chest', 'trapped_chest', 'barrel'])
const SEARCH_RANGE = 32
/** Kept on the bot by `store all`. */
const KEEP = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(bow|crossbow|shield|torch|bucket|water_bucket)$/

const position = { x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional() }
type Position = { x?: number | undefined; y?: number | undefined; z?: number | undefined }

function countItems(items: { name: string; count: number }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

/** The container at x y z, or the nearest one; one remembered to hold `wanted` comes first. */
function findContainer(bot: Bot, repos: Repos, at: Position, wanted?: string): Block {
  if (at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    const block = bot.blockAt(new Vec3(at.x, at.y, at.z))
    if (!block) throw new ToolError(`${at.x} ${at.y} ${at.z} is not loaded; go closer first`)
    if (!STORAGE.has(block.name)) {
      repos.containers.delete(at.x, at.y, at.z)
      throw new ToolError(`there is no chest at ${at.x} ${at.y} ${at.z} (found ${block.name})`)
    }
    return block
  }
  const me = bot.entity.position
  if (wanted) {
    const known = repos.containers
      .list()
      .filter((c) => (c.items[wanted] ?? 0) > 0)
      .flatMap((c) => {
        const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
        if (b && !STORAGE.has(b.name)) repos.containers.delete(c.x, c.y, c.z) // broken since
        return b && STORAGE.has(b.name) ? [b] : []
      })
      .sort((a, b) => me.distanceTo(a.position) - me.distanceTo(b.position))[0]
    if (known) return known
  }
  const ids = [...STORAGE].flatMap((name) => bot.registry.blocksByName[name]?.id ?? [])
  const block = bot.findBlock({ matching: ids, maxDistance: SEARCH_RANGE })
  if (!block) throw new ToolError(`no chest or barrel within ${SEARCH_RANGE} blocks`)
  return block
}

/** Walks to the container, opens it, runs `use`, and remembers what is inside afterwards. */
async function withContainer<T>(bot: Bot, repos: Repos, block: Block, signal: AbortSignal, use: (window: Chest) => Promise<T>): Promise<{ result: T; summary: string }> {
  const { x, y, z } = block.position
  await moveTo(bot, new goals.GoalGetToBlock(x, y, z), signal)
  const window = (await bot.openContainer(block)) as Chest
  try {
    const result = await use(window)
    const stored = { block: block.name, x, y, z, items: countItems(window.containerItems()) }
    repos.containers.save(stored)
    return { result, summary: describeContainer(stored) }
  } finally {
    window.close()
  }
}

export const store = defineTool({
  name: 'store',
  description:
    'Put items from your inventory into a chest or barrel (the one at x y z, or the nearest). item "all" stores everything except tools, weapons, armor and torches. What you store is remembered.',
  schema: z.object({ item: z.string(), count: z.number().int().min(1).optional(), ...position }),
  run: async ({ item, count, ...at }, { bot, repos, signal }) => {
    const carried = countItems(bot.inventory.items())
    const wanted = item === 'all' ? Object.keys(carried).filter((name) => !KEEP.test(name)) : [item]
    if (wanted.length === 0 || (item !== 'all' && !carried[item])) throw new ToolError(item === 'all' ? 'nothing to store' : `no ${item} in inventory`)
    const block = findContainer(bot, repos, at)
    const { result, summary } = await withContainer(bot, repos, block, signal, async (window) => {
      const moved: string[] = []
      for (const name of wanted) {
        const n = Math.min(count ?? Infinity, carried[name] ?? 0)
        try {
          await window.deposit(bot.registry.itemsByName[name]!.id, null, n)
          moved.push(`${name} x${n}`)
        } catch (err) {
          moved.push(`${name} failed (${errorMessage(err)})`)
          break
        }
      }
      return moved
    })
    return `stored ${result.join(', ')}. Now in ${summary}`
  },
})

export const take = defineTool({
  name: 'take',
  description: 'Take items out of a chest or barrel (the one at x y z, or a remembered one holding the item, or the nearest). Omit count to take all of it.',
  schema: z.object({ item: z.string(), count: z.number().int().min(1).optional(), ...position }),
  run: async ({ item, count, ...at }, { bot, repos, signal }) => {
    const id = bot.registry.itemsByName[item]?.id
    if (id === undefined) throw new ToolError(`unknown item "${item}"`)
    const block = findContainer(bot, repos, at, item)
    const { result, summary } = await withContainer(bot, repos, block, signal, async (window) => {
      const inside = countItems(window.containerItems())[item] ?? 0
      if (inside === 0) return 0
      const n = Math.min(count ?? inside, inside)
      await window.withdraw(id, null, n)
      return n
    })
    if (result === 0) throw new ToolError(`no ${item} in ${summary}`)
    return `took ${item} x${result}. Left in ${summary}`
  },
})

export const lookInChest = defineTool({
  name: 'look_in_chest',
  description: 'Open a chest or barrel (the one at x y z, or the nearest) and see what is inside. The contents are remembered.',
  schema: z.object(position),
  run: async (at, { bot, repos, signal }) => {
    const block = findContainer(bot, repos, at)
    return (await withContainer(bot, repos, block, signal, async () => undefined)).summary
  },
})
