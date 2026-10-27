import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Agent } from './agent/agent.ts'
import type { Repos } from './db/repos.ts'
import { goals, isHostile, nearestEntity, NEUTRAL_MOBS, type Entity } from './lib/mc.ts'
import { errorMessage } from './lib/text.ts'
import { fight } from './tools/combat.ts'
import { eatItem, pickFood } from './tools/inventory.ts'

const HUNGRY_BELOW = 14
const THREAT_RANGE = 4
const REFLEX_TIME_LIMIT_MS = 20_000
const RETRY_AFTER_FAILURE_MS = 5_000
const IGNORE_AFTER_FAILED_FIGHT_MS = 45_000
const MAX_THREAT_DY = 2

interface Reflex {
  label: string
  /** Entity this reflex fights; ignored for a while if the fight does not end in a win. */
  threatId?: number
  run: (signal: AbortSignal) => Promise<string>
}

function chooseReflex(bot: Bot, ignoredUntil: Map<number, number>): Reflex | null {
  const now = Date.now()
  const threat = nearestEntity(
    bot,
    (e) =>
      isHostile(e) &&
      !NEUTRAL_MOBS.has(e.name ?? '') &&
      Math.abs(e.position.y - bot.entity.position.y) <= MAX_THREAT_DY &&
      (ignoredUntil.get(e.id) ?? 0) <= now,
    THREAT_RANGE,
  )
  if (threat?.name === 'creeper') return { label: 'fleeing a creeper', run: (signal) => flee(bot, threat, signal) }
  if (threat) return { label: `fighting ${threat.name}`, threatId: threat.id, run: (signal) => fight(bot, threat, signal) }
  if (bot.food < HUNGRY_BELOW) {
    const food = pickFood(bot)
    if (food) return { label: 'eating', run: () => eatItem(bot, food) }
  }
  return null
}

async function flee(bot: Bot, threat: Entity, signal: AbortSignal): Promise<string> {
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 10)), true)
  try {
    await sleep(3_000, undefined, { signal })
  } finally {
    bot.pathfinder.setGoal(null)
  }
  return `ran away, creeper is ${Math.round(bot.entity.position.distanceTo(threat.position))}m away`
}

/** Checks twice a second for danger or hunger and handles it without waiting for the LLM. Returns a stop function. */
export function startReflexes(bot: Bot, agent: Agent, repos: Repos, log: (line: string) => void): () => void {
  let busy = false
  const blockedUntil = new Map<string, number>()
  const ignoredUntil = new Map<number, number>()
  const ignore = (id: number | undefined): void => {
    if (id !== undefined) ignoredUntil.set(id, Date.now() + IGNORE_AFTER_FAILED_FIGHT_MS)
  }
  const timer = setInterval(() => {
    if (busy || !bot.entity || bot.health <= 0) return
    const reflex = chooseReflex(bot, ignoredUntil)
    if (!reflex || (blockedUntil.get(reflex.label) ?? 0) > Date.now()) return
    busy = true
    log(`⚡ reflex: ${reflex.label}`)
    agent
      .exclusive(`reflex: ${reflex.label}`, () => reflex.run(AbortSignal.timeout(REFLEX_TIME_LIMIT_MS)))
      .then((result) => {
        if (reflex.threatId !== undefined && !result.startsWith('defeated')) ignore(reflex.threatId)
        repos.history.add('event', `reflex (${reflex.label}): ${result}`)
      })
      .catch((err) => {
        ignore(reflex.threatId)
        blockedUntil.set(reflex.label, Date.now() + RETRY_AFTER_FAILURE_MS)
        repos.history.add('event', `reflex (${reflex.label}) failed: ${errorMessage(err)}`)
      })
      .finally(() => {
        busy = false
      })
  }, 500)
  return () => clearInterval(timer)
}
