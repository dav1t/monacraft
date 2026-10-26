import type { Bot } from 'mineflayer'
import { biomeAt, describeEntity, isHostile, type Vec3 } from '../lib/mc.ts'
import type { EntityInfo, Equipped, WorldState } from './snapshot.ts'

const AIR = new Set(['air', 'cave_air', 'void_air'])
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
// Slots of the player inventory window that items() leaves out.
const WORN_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, off_hand: 45 } as const

export function readWorldState(bot: Bot): WorldState {
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
    entities: nearbyEntities(bot, 16),
    blocks: countVisibleBlocks(bot, 6),
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

export function nearbyEntities(bot: Bot, radius: number): EntityInfo[] {
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= radius)
    .map((e) => ({ label: describeEntity(e), distance: e.position.distanceTo(me), hostile: isHostile(e) }))
}

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
