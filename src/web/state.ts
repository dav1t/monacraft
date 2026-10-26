import type { Bot } from 'mineflayer'
import { biomeAt, type Item } from '../lib/mc.ts'
import { timeLabel } from '../sensors/snapshot.ts'
import { nearbyEntities } from '../sensors/world.ts'

export interface SlotItem {
  name: string
  displayName: string
  count: number
}

/** Everything the panel shows about the player. Slot arrays keep empty slots as null. */
export interface PlayerState {
  username: string
  health: number
  food: number
  saturation: number
  xp: { level: number; progress: number }
  position: [number, number, number]
  dimension: string
  biome: string
  time: { ticks: number; label: string }
  weather: 'rain' | 'clear'
  gameMode: string
  selectedSlot: number
  armor: (SlotItem | null)[]
  offhand: SlotItem | null
  main: (SlotItem | null)[]
  hotbar: (SlotItem | null)[]
  entities: { label: string; distance: number; hostile: boolean }[]
}

// Player inventory window: 5-8 armor (head to feet), 9-35 main, 36-44 hotbar, 45 offhand.
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export function readPlayerState(bot: Bot): PlayerState {
  const slot = (index: number): SlotItem | null => toSlot(bot.inventory.slots[index])
  const pos = bot.entity.position
  return {
    username: bot.username,
    health: bot.health,
    food: bot.food,
    saturation: bot.foodSaturation,
    xp: { level: bot.experience.level, progress: bot.experience.progress },
    position: [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)],
    dimension: String(bot.game.dimension).replace('minecraft:', ''),
    biome: biomeAt(bot, pos),
    time: { ticks: bot.time.timeOfDay, label: timeLabel(bot.time.timeOfDay) },
    weather: bot.isRaining ? 'rain' : 'clear',
    gameMode: bot.game.gameMode,
    selectedSlot: bot.quickBarSlot,
    armor: range(5, 8).map(slot),
    offhand: slot(45),
    main: range(9, 35).map(slot),
    hotbar: range(36, 44).map(slot),
    entities: nearbyEntities(bot, 24)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20)
      .map((e) => ({ ...e, distance: Math.round(e.distance) })),
  }
}

function toSlot(item: Item | null | undefined): SlotItem | null {
  return item ? { name: item.name, displayName: item.displayName, count: item.count } : null
}
