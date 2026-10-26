import type { Bot } from 'mineflayer'
import { z } from 'zod'
import type { Item } from '../lib/mc.ts'
import { readEquipped } from '../sensors/world.ts'
import { collectNearbyDrops } from './mining.ts'
import { defineTool, ToolError } from './types.ts'

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chicken'])

export function pickFood(bot: Bot): Item | undefined {
  const foods = bot.registry.foodsByName
  return bot.inventory
    .items()
    .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
    .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0]
}

export async function eatItem(bot: Bot, item: Item): Promise<string> {
  await bot.equip(item, 'hand')
  await bot.consume()
  return `ate ${item.name} (food ${bot.food}/20)`
}

export const eat = defineTool({
  name: 'eat',
  description: 'Eat food from your inventory (best available if food is omitted).',
  schema: z.object({ food: z.string().optional() }),
  run: async ({ food }, { bot }) => {
    if (bot.food >= 20) throw new ToolError('not hungry')
    const item = food ? bot.inventory.items().find((i) => i.name === food) : pickFood(bot)
    if (!item) throw new ToolError(food ? `no ${food} in inventory` : 'no food in inventory')
    return eatItem(bot, item)
  },
})

export const equip = defineTool({
  name: 'equip',
  description: 'Hold or wear an item.',
  schema: z.object({ item: z.string(), slot: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).default('hand') }),
  run: async ({ item, slot }, { bot }) => {
    const index = bot.getEquipmentDestSlot(slot)
    if (bot.inventory.slots[index]?.name === item) return `${item} is already equipped (${slot})`
    const found = bot.inventory.items().find((i) => i.name === item)
    if (!found) {
      const worn = Object.entries(readEquipped(bot)).find(([, name]) => name === item)
      throw new ToolError(worn ? `${item} is already equipped (${worn[0]})` : `no ${item} in inventory`)
    }
    await bot.equip(found, slot)
    return `equipped ${item} (${slot})`
  },
})

export const collectDrops = defineTool({
  name: 'collect_drops',
  description: 'Pick up dropped items within 16 blocks.',
  schema: z.object({}),
  run: async (_args, { bot, signal }) => `picked up ${await collectNearbyDrops(bot, signal, 16)} item stacks`,
})
