import type { Bot } from 'mineflayer'
import { z } from 'zod'
import { goals, moveTo, Vec3 } from '../lib/mc.ts'
import { defineTool, ToolError } from './types.ts'

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

/** Right-clicking these opens or uses them instead of placing against them. */
const INTERACTIVE = /crafting_table|furnace|smoker|chest|barrel|_door|_trapdoor|_gate|_bed|_button|lever|anvil|table|loom|stonecutter|grindstone|bell|shulker_box/

/** Places a block of `blockType` at `target`, walking within reach first. Throws ToolError when it can't. */
export async function placeAt(bot: Bot, blockType: string, target: Vec3, signal: AbortSignal): Promise<void> {
  const item = bot.inventory.items().find((i) => i.name === blockType)
  if (!item) throw new ToolError(`no ${blockType} in inventory`)
  const { x, y, z } = target
  const current = bot.blockAt(target)
  if (current && current.boundingBox !== 'empty') throw new ToolError(`${x} ${y} ${z} is occupied by ${current.name}`)
  const face = FACES.find((f) => {
    const neighbour = bot.blockAt(target.plus(f))
    return neighbour?.boundingBox === 'block' && !INTERACTIVE.test(neighbour.name)
  })
  if (!face) throw new ToolError(`nothing solid next to ${x} ${y} ${z} to place against`)
  const reference = bot.blockAt(target.plus(face))!

  // Stand within reach but not inside the target spot.
  const spot = new goals.GoalCompositeAll([new goals.GoalNear(x, y, z, 4), new goals.GoalInvert(new goals.GoalNear(x, y, z, 1.5))])
  await moveTo(bot, spot, signal)
  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(reference, face.scaled(-1))
  } catch (err) {
    // placeBlock sometimes times out waiting for the server's confirmation although the block was placed.
    if (bot.blockAt(target)?.name !== blockType) throw err
  }
}

export const place = defineTool({
  name: 'place',
  description: 'Place one block from your inventory at x y z. Needs a solid block next to that spot. For walls, floors or a shelter use build.',
  schema: z.object({ block_type: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  run: async ({ block_type, x, y, z }, { bot, signal }) => {
    await placeAt(bot, block_type, new Vec3(x, y, z), signal)
    return `placed ${block_type} at ${x} ${y} ${z}`
  },
})
