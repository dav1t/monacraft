import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { describeEntity, goals, nearestEntity, type Entity } from '../lib/mc.ts'
import { collectNearbyDrops } from './mining.ts'
import { defineTool, ToolError } from './types.ts'

const WEAPONS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].flatMap((m) => [`${m}_sword`, `${m}_axe`])

export async function equipBestWeapon(bot: Bot): Promise<void> {
  const items = bot.inventory.items()
  for (const name of WEAPONS) {
    const weapon = items.find((i) => i.name === name)
    if (weapon) {
      if (bot.heldItem?.name !== name) await bot.equip(weapon, 'hand')
      return
    }
  }
}

/** Chase and hit `target` until it dies, escapes or the signal aborts. */
export async function fight(bot: Bot, target: Entity, signal: AbortSignal): Promise<string> {
  const label = describeEntity(target)
  await equipBestWeapon(bot)
  let following = false
  try {
    while (target.isValid) {
      signal.throwIfAborted()
      const distance = bot.entity.position.distanceTo(target.position)
      if (distance > 24) return `${label} got away`
      if (distance > 3) {
        // Re-setting the goal resets the path and control states, so only set it when not already following this target.
        const current = bot.pathfinder.goal
        if (!(current instanceof goals.GoalFollow && current.entity === target)) {
          bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
        }
        following = true
      } else {
        if (following) bot.pathfinder.setGoal(null)
        following = false
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
      }
      await sleep(625, undefined, { signal }) // attack cooldown
    }
    return `defeated ${label}`
  } finally {
    bot.pathfinder.setGoal(null)
  }
}

export const attack = defineTool({
  name: 'attack',
  description: 'Fight the nearest entity of a type (e.g. zombie, cow) or a player by name until it dies, then pick up drops.',
  schema: z.object({ target: z.string() }),
  timeoutMs: 60_000,
  run: async ({ target }, { bot, signal }) => {
    const entity = nearestEntity(bot, (e) => e.name === target || e.username === target, 32)
    if (!entity) throw new ToolError(`no ${target} within 32 blocks`)
    const result = await fight(bot, entity, signal)
    const picked = await collectNearbyDrops(bot, signal, 6)
    return picked > 0 ? `${result}, picked up ${picked} drops` : result
  },
})
