import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { goals, moveTo } from '../lib/mc.ts'
import { defineTool, ToolError } from './types.ts'

type Recipe = ReturnType<Bot['recipesFor']>[number]

function maxCrafts(bot: Bot, recipe: Recipe): number {
  let max = Number.POSITIVE_INFINITY
  for (const { id, count } of recipe.delta) {
    if (count < 0) max = Math.min(max, Math.floor(bot.inventory.count(id, null) / -count))
  }
  return max
}

function explainMissing(bot: Bot, itemId: number, item: string, haveTable: boolean): string {
  const recipes = bot.recipesAll(itemId, null, true)
  if (recipes.length === 0) return `${item} has no crafting recipe — smelt it, mine it or find it instead`
  const options = recipes.slice(0, 3).map((r) =>
    r.delta
      .filter((d) => d.count < 0)
      .map((d) => `${-d.count} ${bot.registry.items[d.id]?.name ?? d.id}`)
      .join(' + '),
  )
  const needsTable = recipes.every((r) => r.requiresTable) && !haveTable
  // When the table is the only thing missing, say exactly that; listing ingredients the bot already has misleads it.
  const hasIngredients = recipes.some((r) => maxCrafts(bot, r) >= 1)
  if (needsTable && hasIngredients) {
    const carried = bot.inventory.items().some((i) => i.name === 'crafting_table')
    return `you have the ingredients for ${item}; only a crafting_table within 32 blocks is missing — ${
      carried ? 'you carry one: place it next to you first (place)' : 'craft one (4 planks) and place it first'
    }`
  }
  const tableNote = needsTable ? '; needs a crafting_table within 32 blocks' : ''
  return `cannot craft ${item} yet. One craft needs ${[...new Set(options)].join(' OR ')}${tableNote}`
}

const WEARABLE = /_(helmet|chestplate|leggings|boots)$|^shield$/

export const craft = defineTool({
  name: 'craft',
  description: 'Craft an item (count = items wanted). 3x3 recipes need a crafting_table within 32 blocks — place one first.',
  schema: z.object({ item: z.string(), count: z.number().int().min(1).max(64).default(1) }),
  run: async ({ item, count }, { bot, signal }) => {
    const def = bot.registry.itemsByName[item]
    if (!def) throw new ToolError(`unknown item "${item}"`)
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 32 })
    const recipe = bot.recipesFor(def.id, null, 1, null)[0] ?? (table ? bot.recipesFor(def.id, null, 1, table)[0] : undefined)
    if (!recipe) throw new ToolError(explainMissing(bot, def.id, item, table !== null))
    if (recipe.requiresTable && table) {
      await moveTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3), signal)
    }
    const times = Math.min(Math.ceil(count / recipe.result.count), maxCrafts(bot, recipe))
    await bot.craft(recipe, times, recipe.requiresTable ? (table ?? undefined) : undefined)
    const crafted = `crafted ${times * recipe.result.count} ${item} (now have ${bot.inventory.count(def.id, null)})`
    // armorManager only reacts to armor picked up from the ground; crafted armor (and shields) are put on here.
    if (WEARABLE.test(item)) {
      await bot.armorManager.equipAll()
      return `${crafted}, now wearing the best armor you have`
    }
    return crafted
  },
})

function fuelValue(name: string): number {
  if (name === 'coal' || name === 'charcoal') return 8
  if (name === 'coal_block') return 80
  if (name.endsWith('_planks') || name.endsWith('_log') || name.endsWith('_wood')) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

export const smelt = defineTool({
  name: 'smelt',
  description: 'Smelt items (e.g. raw_iron, sand, beef) in a furnace within 32 blocks. Uses coal, charcoal, planks or logs as fuel.',
  schema: z.object({ item: z.string(), count: z.number().int().min(1).max(16).default(1) }),
  timeoutMs: 240_000,
  run: async ({ item, count }, { bot, signal }) => {
    const furnaceBlock = bot.findBlock({ matching: bot.registry.blocksByName.furnace!.id, maxDistance: 32 })
    if (!furnaceBlock) throw new ToolError('no furnace within 32 blocks — craft and place one first')
    const input = bot.inventory.items().find((i) => i.name === item)
    if (!input) throw new ToolError(`no ${item} in inventory`)
    const total = Math.min(count, bot.inventory.count(input.type, null))
    const { x, y, z } = furnaceBlock.position
    await moveTo(bot, new goals.GoalNear(x, y, z, 3), signal)

    const furnace = await bot.openFurnace(furnaceBlock)
    try {
      if (furnace.outputItem()) await furnace.takeOutput()
      if (!furnace.fuelItem()) {
        const fuel = bot.inventory
          .items()
          .filter((i) => fuelValue(i.name) > 0 && i.name !== item)
          .sort((a, b) => fuelValue(b.name) - fuelValue(a.name))[0]
        if (!fuel) throw new ToolError('no fuel: need coal, charcoal, planks or logs')
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(total / fuelValue(fuel.name))))
      }
      await furnace.putInput(input.type, null, total)
      let done = 0
      while (done < total) {
        await sleep(1_000, undefined, { signal })
        const output = furnace.outputItem()
        if (output) {
          done += output.count
          await furnace.takeOutput()
        } else if (!furnace.inputItem()) {
          break
        } else if (!furnace.fuelItem() && furnace.fuel === 0) {
          throw new ToolError(`ran out of fuel after smelting ${done}`)
        }
      }
      return `smelted ${done} ${item}`
    } finally {
      furnace.close()
    }
  },
})
