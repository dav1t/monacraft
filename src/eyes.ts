import type { Bot } from 'mineflayer'
import type { Repos } from './db/repos.ts'
import { describeEntity, isHostile, NEUTRAL_MOBS } from './lib/mc.ts'
import { errorMessage } from './lib/text.ts'
import { relative, type Point } from './sensors/geometry.ts'
import type { EntityInfo, SeenBlock } from './sensors/snapshot.ts'
import { scanNotable, type Senses } from './sensors/world.ts'

/** Hostiles are announced within this range; players within PLAYER_RANGE and gone beyond PLAYER_GONE. */
const HOSTILE_RANGE = 16
const PLAYER_RANGE = 32
const PLAYER_GONE = 40
/** A hostile closer than this and approaching interrupts the current action. */
const URGENT_RANGE = 10
const HEALTH_DROP = 4
const LOW_HEALTH = 6
/** The same urgent thing interrupts at most once in this long. */
const URGENT_COOLDOWN_MS = 20_000
/** Distance changes smaller than this are not movement. */
const MOVE_EPSILON = 0.5
const LOOK_MS = 500
/** Searching blocks takes tens of milliseconds, so it runs this often. */
const BLOCK_LOOK_MS = 4_000
const RARE_ORES = new Set([
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'gold_ore', 'deepslate_gold_ore',
  'iron_ore', 'deepslate_iron_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'ancient_debris',
])
/** Actions an interrupt would only hurt. */
export const DO_NOT_INTERRUPT = new Set(['attack', 'eat', 'sleep'])

export interface SeenEntity {
  id: number
  label: string
  hostile: boolean
  neutral: boolean
  player: boolean
  position: Point
}

/** What the eyes see in one look, decoupled from mineflayer so the logic is testable. */
export interface View {
  health: number
  position: Point
  entities: SeenEntity[]
  lavaNear: boolean
  /** Useful blocks in sight; only on the slower block look, otherwise the last ones are kept. */
  notable?: SeenBlock[]
}

/**
 * Watches continuously and turns changes into short events (for the history) and urgent reasons (to interrupt the
 * current action). Each thing is reported once, and each urgent reason at most once per URGENT_COOLDOWN_MS.
 */
export class Eyes implements Senses {
  readonly #distances = new Map<number, number>()
  readonly #trends = new Map<number, EntityInfo['trend']>()
  readonly #hostilesSeen = new Set<number>()
  readonly #playersNear = new Set<string>()
  readonly #oresSeen = new Set<string>()
  readonly #urgentAt = new Map<string, number>()
  #health: number | null = null
  #notable: SeenBlock[] = []

  /** The useful blocks seen on the last block look. */
  get notable(): SeenBlock[] {
    return this.#notable
  }

  trendOf(id: number): EntityInfo['trend'] {
    return this.#trends.get(id)
  }

  look(view: View, now: number): { events: string[]; urgent: string | null } {
    const events: string[] = []
    const urgent: [key: string, reason: string][] = []
    const present = new Set<number>()
    const playersHere = new Set<string>()

    for (const e of view.entities) {
      present.add(e.id)
      const { distance, direction } = relative(view.position, e.position)
      const exact = Math.hypot(e.position.x - view.position.x, e.position.y - view.position.y, e.position.z - view.position.z)
      const before = this.#distances.get(e.id)
      this.#distances.set(e.id, exact)
      const trend = before === undefined ? undefined : exact < before - MOVE_EPSILON ? 'approaching' : exact > before + MOVE_EPSILON ? 'moving away' : undefined
      if (trend) this.#trends.set(e.id, trend)
      else this.#trends.delete(e.id)

      if (e.player) {
        const name = e.label.replace(/^player:/, '')
        if (exact <= PLAYER_GONE && (this.#playersNear.has(name) || exact <= PLAYER_RANGE)) {
          if (!this.#playersNear.has(name)) events.push(`${name} came near (${distance}m ${direction})`)
          playersHere.add(name)
        }
      } else if (e.hostile && exact <= HOSTILE_RANGE) {
        if (!this.#hostilesSeen.has(e.id)) {
          this.#hostilesSeen.add(e.id)
          events.push(`${e.label} appeared ${distance}m ${direction}`)
        }
        if (!e.neutral && exact <= URGENT_RANGE && trend === 'approaching') {
          urgent.push([`hostile:${e.id}`, `${e.label} closing in from ${direction} (${distance}m)`])
        }
      }
    }
    for (const name of this.#playersNear) if (!playersHere.has(name)) events.push(`${name} left`)
    this.#playersNear.clear()
    for (const name of playersHere) this.#playersNear.add(name)
    // Forget mobs that are gone, so a new one with a reused id is announced.
    for (const id of [...this.#distances.keys()]) {
      if (present.has(id)) continue
      this.#distances.delete(id)
      this.#trends.delete(id)
      this.#hostilesSeen.delete(id)
    }

    if (this.#health === null || view.health > this.#health) this.#health = view.health
    else if (view.health <= this.#health - HEALTH_DROP) {
      events.push(`health fell to ${view.health} (was ${this.#health})`)
      this.#health = view.health
    }
    if (view.health <= LOW_HEALTH) urgent.unshift(['health', `health is low (${view.health})`])
    if (view.lavaNear) urgent.unshift(['lava', 'lava right next to you'])

    if (view.notable) this.#notable = view.notable
    for (const block of view.notable ?? []) {
      if (!RARE_ORES.has(block.name)) continue
      const key = `${block.name} ${block.position.x} ${block.position.y} ${block.position.z}`
      if (this.#oresSeen.has(key)) continue
      this.#oresSeen.add(key)
      const { distance, direction } = relative(view.position, block.position)
      events.push(`spotted ${block.name} at ${block.position.x} ${block.position.y} ${block.position.z} (${distance}m ${direction})`)
    }

    const due = urgent.find(([key]) => now - (this.#urgentAt.get(key) ?? -Infinity) >= URGENT_COOLDOWN_MS)
    if (due) this.#urgentAt.set(due[0], now)
    return { events, urgent: due?.[1] ?? null }
  }
}

/** The parts of the agent the eyes use. */
export interface WatchedAgent {
  readonly currentTool: string | null
  interrupt(reason: string): void
}

/** Looks every LOOK_MS (blocks every BLOCK_LOOK_MS), writes what changed to the history and interrupts for urgent things. */
export function startEyes(bot: Bot, eyes: Eyes, agent: WatchedAgent, repos: Repos, log: (line: string) => void): () => void {
  const lavaId = bot.registry.blocksByName.lava?.id
  let lastBlockLook = -Infinity
  const timer = setInterval(() => {
    if (!bot.entity || bot.health <= 0) return
    try {
      const now = Date.now()
      const pos = bot.entity.position
      const blockLook = now - lastBlockLook >= BLOCK_LOOK_MS
      if (blockLook) lastBlockLook = now
      const view: View = {
        health: Math.round(bot.health),
        position: pos,
        entities: Object.values(bot.entities)
          .filter((e) => e !== bot.entity && e.position.distanceTo(pos) <= PLAYER_GONE + 8)
          .map((e) => ({
            id: e.id,
            label: describeEntity(e),
            hostile: isHostile(e),
            neutral: NEUTRAL_MOBS.has(e.name ?? ''),
            player: e.type === 'player',
            position: e.position,
          })),
        lavaNear: lavaId !== undefined && bot.findBlocks({ matching: lavaId, maxDistance: 2, count: 1 }).length > 0,
        ...(blockLook && { notable: scanNotable(bot) }),
      }
      const { events, urgent } = eyes.look(view, now)
      for (const event of events) repos.history.add('event', `👁 ${event}`)
      const tool = agent.currentTool
      // No tool running means the agent is thinking; that is interrupted too, so it decides with the news.
      if (urgent && !(tool && DO_NOT_INTERRUPT.has(tool))) {
        log(`👁 ${urgent} — interrupting ${tool ?? 'thinking'}`)
        agent.interrupt(urgent)
      }
    } catch (err) {
      log(`⚠ eyes: ${errorMessage(err)}`)
    }
  }, LOOK_MS)
  return () => clearInterval(timer)
}
