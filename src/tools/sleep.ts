import type { Bot } from 'mineflayer'
import { z } from 'zod'
import { formatPos, goals, moveTo, Vec3, type Block } from '../lib/mc.ts'
import { errorMessage } from '../lib/text.ts'
import { defineTool, ToolError } from './types.ts'

const BED_RANGE = 64
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

const empty = (bot: Bot, pos: Vec3): boolean => bot.blockAt(pos)?.boundingBox === 'empty'
const solid = (bot: Bot, pos: Vec3): boolean => bot.blockAt(pos)?.boundingBox === 'block'

/** Places a carried bed two blocks away, foot towards the bot, where both halves fit on solid ground. */
async function placeBed(bot: Bot): Promise<Block> {
  const item = bot.inventory.items().find((i) => i.name.endsWith('_bed'))
  if (!item) throw new ToolError(`no bed within ${BED_RANGE} blocks and none in your inventory — craft one (3 wool + 3 planks)`)
  const { x, y, z } = bot.entity.position.floored()
  const feet = new Vec3(x, y, z)
  for (const dir of DIRECTIONS) {
    const foot = feet.plus(dir.scaled(2))
    const head = foot.plus(dir)
    if (!empty(bot, foot) || !empty(bot, head) || !solid(bot, foot.offset(0, -1, 0)) || !solid(bot, head.offset(0, -1, 0))) continue
    await bot.equip(item, 'hand')
    // A bed is placed facing the way the player looks: look along dir so the head goes away from the bot.
    await bot.look(Math.atan2(-dir.x, -dir.z), -0.6, true)
    try {
      await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0))!, new Vec3(0, 1, 0))
    } catch {
      // The server may confirm late; check below.
    }
    const placed = bot.blockAt(foot)
    if (placed && bot.isABed(placed)) return placed
  }
  throw new ToolError('no flat 2-block spot next to you to place the bed; move to open flat ground')
}

export const sleep = defineTool({
  name: 'sleep',
  description: `Sleep in a bed within ${BED_RANGE} blocks (or place the bed you carry). Only at night or in a thunderstorm; you reflect on the day while asleep.`,
  schema: z.object({}),
  timeoutMs: 120_000,
  run: async (_args, { bot, signal }) => {
    if (bot.isSleeping) return 'already in bed'
    const t = bot.time.timeOfDay
    if ((t < 12_542 || t > 23_459) && !bot.thunderState) throw new ToolError('you can only sleep at night or during a thunderstorm')
    const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: BED_RANGE }) ?? (await placeBed(bot))
    const { x, y, z } = bed.position
    await moveTo(bot, new goals.GoalNear(x, y, z, 2), signal)
    try {
      await bot.sleep(bed)
    } catch (err) {
      throw new ToolError(`could not sleep: ${errorMessage(err)}`)
    }
    return `lying in the bed at ${formatPos(bed.position)}; you are reflecting on the day`
  },
})
