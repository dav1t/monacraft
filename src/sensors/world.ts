import type { Bot } from 'mineflayer'
import { biomeAt, describeEntity, isHostile, type Vec3 } from '../lib/mc.ts'
import type { EntityInfo, WorldState } from './snapshot.ts'

const AIR = new Set(['air', 'cave_air', 'void_air'])
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
const ARMOR_SLOTS = [5, 6, 7, 8] // head, chest, legs, feet in the player inventory window

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
    held: bot.heldItem?.name ?? null,
    armor: ARMOR_SLOTS.flatMap((slot) => bot.inventory.slots[slot]?.name ?? []),
    cursorBlock: bot.blockAtCursor(5)?.name ?? null,
    inventory: countInventory(bot),
    entities: nearbyEntities(bot, 16),
    blocks: countVisibleBlocks(bot, 6),
  }
}

export function countInventory(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
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
