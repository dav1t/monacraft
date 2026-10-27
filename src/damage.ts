import type { Bot } from 'mineflayer'
import type { Repos } from './db/repos.ts'
import { DO_NOT_INTERRUPT } from './eyes.ts'
import { describeEntity, type Entity } from './lib/mc.ts'
import { errorMessage } from './lib/text.ts'
import { relative, type Point } from './sensors/geometry.ts'

/** The same cause is noted at most once in this long (drowning or burning hurt every second). */
const NOTE_COOLDOWN_MS = 10_000
/** A cause the mind already heard about interrupts again only after this long. */
const INTERRUPT_COOLDOWN_MS = 30_000
/** The hit arrives a moment before the new health; wait for it. */
const HEALTH_SETTLE_MS = 250

/** Damage types whose name alone says what happened. */
const PLAIN_CAUSES: Record<string, string> = {
  fall: 'you took fall damage',
  drown: 'you are drowning',
  in_fire: 'you are standing in fire',
  on_fire: 'you are on fire',
  lava: 'you are in lava',
  hot_floor: 'you are standing on a magma block',
  starve: 'you are starving',
  in_wall: 'you are suffocating inside a block',
  cactus: 'a cactus pricked you',
  sweet_berry_bush: 'a sweet berry bush scratched you',
  freeze: 'you are freezing in powder snow',
  lightning_bolt: 'lightning struck you',
  fly_into_wall: 'you flew into a wall',
  out_of_world: 'you fell out of the world',
}

const damageTypes = new WeakMap<Bot, string[]>()

/**
 * Damage types arrive by index; the server sends their names while the bot joins. Call right after createBot, before
 * that happens.
 */
export function recordDamageTypes(bot: Bot): void {
  bot._client.on('registry_data', (packet: { id?: string; entries?: { key: string }[] }) => {
    if (packet.id?.replace('minecraft:', '') !== 'damage_type' || !packet.entries) return
    damageTypes.set(bot, packet.entries.map((e) => e.key.replace('minecraft:', '')))
  })
}

export interface Hit {
  /** Damage type, e.g. `arrow`, `fall`, `mob_attack`. */
  type: string
  /** Who is behind it (the skeleton, not its arrow), when anyone is. */
  attacker?: { label: string; position: Point }
  /** Where the bot is. */
  position: Point
  health: number
}

/** One line for the history, e.g. `hurt by skeleton (arrow, 18m NE) — health 14`. */
export function describeHit({ type, attacker, position, health }: Hit): string {
  const status = `health ${Math.round(health)}`
  if (attacker) {
    const { distance, direction } = relative(position, attacker.position)
    const how = type === 'mob_attack' || type === 'player_attack' ? '' : `${type.replace(/_/g, ' ')}, `
    return `hurt by ${attacker.label} (${how}${distance}m ${direction}) — ${status}`
  }
  return `${PLAIN_CAUSES[type] ?? `you took ${type.replace(/_/g, ' ')} damage`} — ${status}`
}

/** Decides which hits are worth a note and which should stop what the bot is doing. */
export class DamageSense {
  readonly #notedAt = new Map<string, number>()
  readonly #interruptedAt = new Map<string, number>()

  /** The note for the history (null when this cause was noted moments ago) and whether to interrupt. */
  hurt(hit: Hit, now: number): { note: string | null; interrupt: boolean } {
    const key = `${hit.type}:${hit.attacker?.label ?? ''}`
    if (now - (this.#notedAt.get(key) ?? -Infinity) < NOTE_COOLDOWN_MS) return { note: null, interrupt: false }
    this.#notedAt.set(key, now)
    const interrupt = now - (this.#interruptedAt.get(key) ?? -Infinity) >= INTERRUPT_COOLDOWN_MS
    if (interrupt) this.#interruptedAt.set(key, now)
    return { note: describeHit(hit), interrupt }
  }
}

/** The parts of the agent a hit can stop. */
export interface HurtAgent {
  readonly currentTool: string | null
  interrupt(reason: string): void
}

/** Notes every hit with its cause in the history, and interrupts the agent (thinking or acting) for news. */
export function watchDamage(bot: Bot, agent: HurtAgent, repos: Repos, log: (line: string) => void): () => void {
  const sense = new DamageSense()
  let timers: NodeJS.Timeout[] = []
  const onDamage = (packet: { entityId: number; sourceTypeId: number; sourceCauseId: number }): void => {
    if (packet.entityId !== bot.entity?.id) return
    const type = damageTypes.get(bot)?.[packet.sourceTypeId] ?? `damage #${packet.sourceTypeId}`
    // Ids arrive plus one, 0 meaning nobody.
    const attacker: Entity | undefined = packet.sourceCauseId > 0 ? bot.entities[packet.sourceCauseId - 1] : undefined
    const timer = setTimeout(() => {
      timers = timers.filter((t) => t !== timer)
      if (!bot.entity || bot.health <= 0) return
      try {
        const hit: Hit = {
          type,
          ...(attacker && { attacker: { label: describeEntity(attacker), position: attacker.position } }),
          position: bot.entity.position,
          health: bot.health,
        }
        const { note, interrupt } = sense.hurt(hit, Date.now())
        if (!note) return
        repos.history.add('event', note)
        const tool = agent.currentTool
        if (interrupt && !(tool && DO_NOT_INTERRUPT.has(tool))) {
          log(`💢 ${note} — interrupting ${tool ?? 'thinking'}`)
          agent.interrupt(note)
        }
      } catch (err) {
        log(`⚠ damage: ${errorMessage(err)}`)
      }
    }, HEALTH_SETTLE_MS)
    timers.push(timer)
  }
  bot._client.on('damage_event', onDamage)
  return () => {
    bot._client.removeListener('damage_event', onDamage)
    for (const timer of timers) clearTimeout(timer)
  }
}
