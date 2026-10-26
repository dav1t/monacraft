import type { Bot } from 'mineflayer'
import { countOwned } from '../sensors/world.ts'
import type { McData } from './data.ts'
import type { Inventory, Stations } from './planner.ts'

/** What the planner needs to know about the bot: recipes, what it carries, and which stations are near. */
export interface PlanningWorld {
  data: McData
  inventory(): Inventory
  stations(): Stations
}

const STATION_RANGE = 32

/** The planning view of a connected bot; null for a bot without a registry (not spawned, or a test stub). */
export function botWorld(bot: Bot): PlanningWorld | null {
  if (!bot.registry) return null
  const near = (name: string): boolean => {
    const id = bot.registry.blocksByName[name]?.id
    return id !== undefined && bot.findBlock({ matching: id, maxDistance: STATION_RANGE }) !== null
  }
  return {
    data: bot.registry as unknown as McData,
    inventory: () => countOwned(bot),
    stations: () => ({ craftingTable: near('crafting_table'), furnace: near('furnace') }),
  }
}
