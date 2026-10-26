import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { describeEntity, nearestEntity, type Entity } from '../lib/mc.ts'
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

/** Past this distance the target counts as escaped. */
const ESCAPE_DISTANCE = 24

/**
 * Chase and hit `target` until it dies, escapes or the signal aborts. mineflayer-pvp does the fighting: it follows the
 * target, times hits to the attack cooldown for full damage, and raises a shield against an exploding creeper.
 */
export async function fight(bot: Bot, target: Entity, signal: AbortSignal): Promise<string> {
  const label = describeEntity(target)
  await equipBestWeapon(bot)
  signal.throwIfAborted()
  bot.pvp.viewDistance = ESCAPE_DISTANCE
  void bot.pvp.attack(target)
  try {
    // pvp drops the target when it dies or gets too far away.
    while (target.isValid && bot.pvp.target === target) {
      await sleep(250, undefined, { signal })
    }
    return target.isValid ? `${label} got away` : `defeated ${label}`
  } finally {
    // forceStop ends at once; stop() would wait up to 5 s for the path to settle.
    bot.pvp.forceStop()
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
