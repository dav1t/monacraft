import type { Bot } from 'mineflayer'
import { biomeAt, describeEntity, isHostile, type Vec3 } from '../lib/mc.ts'
import { relative } from './geometry.ts'
import { groupNotable, type EntityInfo, type Equipped, type SeenBlock, type WorldState } from './snapshot.ts'

const AIR = new Set(['air', 'cave_air', 'void_air'])
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
/** How far the eyes look for useful blocks, and how many of each group (ores / the rest) they consider. */
const NOTABLE_RANGE = 16
const NOTABLE_SCAN = 64
const NOTABLE_NAMES = new Set(['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'lava', 'spawner', 'ancient_debris'])

/** Blocks worth knowing the position of: ores, logs, storage, stations, beds, lava, spawners. */
export function isNotable(name: string): boolean {
  return name.endsWith('_ore') || name.endsWith('_log') || name.endsWith('_bed') || NOTABLE_NAMES.has(name)
}

/** What the eyes (eyes.ts) add to a snapshot: how entities move, and the useful blocks they last saw. */
export interface Senses {
  trendOf(entityId: number): EntityInfo['trend']
  readonly notable: SeenBlock[]
}

const NO_SENSES: Senses = { trendOf: () => undefined, notable: [] }

// Slots of the player inventory window that items() leaves out.
const WORN_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, off_hand: 45 } as const

export function readWorldState(bot: Bot, senses: Senses = NO_SENSES): WorldState {
  const pos = bot.entity.position
  return {
    health: Math.round(bot.health),
    food: bot.food,
    xpLevel: bot.experience.level,
    position: [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)],
    yaw: bot.entity.yaw,
    biome: biomeAt(bot, pos),
    timeOfDay: bot.time.timeOfDay,
    raining: bot.isRaining,
    equipped: readEquipped(bot),
    cursorBlock: bot.blockAtCursor(5)?.name ?? null,
    inventory: countInventory(bot),
    entities: nearbyEntities(bot, 16, (id) => senses.trendOf(id)),
    blocks: countVisibleBlocks(bot, 6),
    notable: groupNotable(senses.notable, pos),
  }
}

/** What is in hand and worn; empty slots are left out. */
export function readEquipped(bot: Bot): Equipped {
  const equipped: Equipped = {}
  if (bot.heldItem) equipped.hand = bot.heldItem.name
  for (const [slot, index] of Object.entries(WORN_SLOTS)) {
    const item = bot.inventory.slots[index]
    if (item) equipped[slot as keyof typeof WORN_SLOTS] = item.name
  }
  return equipped
}

/** Items carried in the inventory and hotbar (the held item too, but not worn armor or the off-hand). */
export function countInventory(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

/** Everything the bot has on it: carried plus worn and off-hand. What goals check against. */
export function countOwned(bot: Bot): Record<string, number> {
  const counts = countInventory(bot)
  for (const index of Object.values(WORN_SLOTS)) {
    const item = bot.inventory.slots[index]
    if (item) counts[item.name] = (counts[item.name] ?? 0) + item.count
  }
  return counts
}

export function nearbyEntities(bot: Bot, radius: number, trendOf: Senses['trendOf'] = () => undefined): EntityInfo[] {
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= radius)
    .map((e) => {
      const trend = trendOf(e.id)
      return {
        label: describeEntity(e),
        distance: e.position.distanceTo(me),
        hostile: isHostile(e),
        direction: relative(me, e.position).direction,
        ...(trend && { trend }),
      }
    })
}

/**
 * Useful blocks a player could see within NOTABLE_RANGE (touching air or another non-solid block). Logs, stations and
 * lava are searched apart from ores, so buried ores cannot use up the search. Takes tens of milliseconds, so the eyes
 * run it every few seconds and the snapshot uses their last result.
 */
export function scanNotable(bot: Bot): SeenBlock[] {
  const blocks = bot.registry.blocksArray.filter((b) => isNotable(b.name))
  const ores = blocks.filter((b) => isOre(b.name)).map((b) => b.id)
  const others = blocks.filter((b) => !isOre(b.name)).map((b) => b.id)
  const seen: SeenBlock[] = []
  for (const ids of [others, ores]) {
    for (const pos of bot.findBlocks({ matching: ids, maxDistance: NOTABLE_RANGE, count: NOTABLE_SCAN })) {
      const block = bot.blockAt(pos)
      if (block && isExposed(bot, block.position)) seen.push({ name: block.name, position: { x: pos.x, y: pos.y, z: pos.z } })
    }
  }
  return seen
}

const isOre = (name: string): boolean => name.endsWith('_ore') || name === 'ancient_debris'

/** Counts blocks in a cube that touch a non-solid block — roughly what a player could see. */
export function countVisibleBlocks(bot: Bot, radius: number): Record<string, number> {
  const center = bot.entity.position.floored()
  const counts: Record<string, number> = {}
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const block = bot.blockAt(center.offset(dx, dy, dz))
        if (!block || AIR.has(block.name) || !isExposed(bot, block.position)) continue
        counts[block.name] = (counts[block.name] ?? 0) + 1
      }
    }
  }
  return counts
}

function isExposed(bot: Bot, pos: Vec3): boolean {
  return NEIGHBOURS.some(([x, y, z]) => bot.blockAt(pos.offset(x, y, z))?.boundingBox === 'empty')
}
