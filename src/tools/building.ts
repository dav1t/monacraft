import { z } from 'zod'
import { goals, moveTo, Vec3 } from '../lib/mc.ts'
import { defineTool, ToolError } from './types.ts'

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

export const place = defineTool({
  name: 'place',
  description: 'Place a block from your inventory at x y z. Needs a solid block next to that spot.',
  schema: z.object({ block_type: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  run: async ({ block_type, x, y, z }, { bot, signal }) => {
    const item = bot.inventory.items().find((i) => i.name === block_type)
    if (!item) throw new ToolError(`no ${block_type} in inventory`)
    const target = new Vec3(x, y, z)
    const current = bot.blockAt(target)
    if (current && current.boundingBox !== 'empty') throw new ToolError(`${x} ${y} ${z} is occupied by ${current.name}`)
    const face = FACES.find((f) => bot.blockAt(target.plus(f))?.boundingBox === 'block')
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
      if (bot.blockAt(target)?.name !== block_type) throw err
    }
    return `placed ${block_type} at ${x} ${y} ${z}`
  },
})
