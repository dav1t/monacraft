import type { Day, DayKind, Repos } from './db/repos.ts'
import { formatPos } from './lib/mc.ts'
import { errorMessage } from './lib/text.ts'

/** How long a death waits for the server's death message ("<name> was shot by Skeleton"); it can come before or after. */
const CAUSE_WAIT_MS = 1_500
/** Dying again soon after does not start another reflection. */
const NAP_COOLDOWN_MS = 3 * 60_000
const MAX_LOST_ITEMS = 8

/** The parts of a mineflayer bot this uses. */
export interface DeathBot {
  username: string
  entity: { position: { x: number; y: number; z: number } }
  inventory: { items(): { name: string; count: number }[] }
  on(event: 'death', listener: () => void): unknown
  on(event: 'messagestr', listener: (message: string, position: string, json: unknown) => void): unknown
  removeListener(event: 'death', listener: () => void): unknown
  removeListener(event: 'messagestr', listener: (message: string, position: string, json: unknown) => void): unknown
}

export interface DeathOptions {
  bot: DeathBot
  repos: Repos
  sleep: { readonly busy: boolean; run(kind: DayKind): Promise<Day> }
  log: (line: string) => void
  /** Replaceable in tests. */
  waitMs?: number
  now?: () => number
}

/** What it carried, biggest stacks first: "12 cobblestone, 1 iron_pickaxe…". */
function describeItems(items: { name: string; count: number }[]): string {
  if (items.length === 0) return 'nothing'
  const totals = new Map<string, number>()
  for (const { name, count } of items) totals.set(name, (totals.get(name) ?? 0) + count)
  const sorted = [...totals].sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, MAX_LOST_ITEMS).map(([name, count]) => `${count} ${name}`).join(', ')
  return sorted.length > MAX_LOST_ITEMS ? `${shown} and ${sorted.length - MAX_LOST_ITEMS} more kinds` : shown
}

/**
 * Tells the agent how it died (the cause comes from the server's death message), keeps the death as a scar and
 * reflects on it right away, so the lesson (and what the death means to the bot) comes while it is fresh instead of
 * at night. Returns a stop function.
 */
export function watchDeaths({ bot, repos, sleep, log, waitMs = CAUSE_WAIT_MS, now = Date.now }: DeathOptions): () => void {
  let lastCause: { cause: string; at: number } | null = null
  let pending: { position: string; lost: string; timer: NodeJS.Timeout } | null = null
  let lastNap = -Infinity

  const record = (position: string, lost: string, cause: string | null): void => {
    pending = null
    lastCause = null
    repos.scars.add({ cause: cause ? `died (${cause})` : 'died', place: position, lost })
    const how = cause ? ` (${cause})` : ''
    repos.history.add(
      'event',
      `you died${how} at ${position} and respawned; your items dropped there. Think about what killed you and how to avoid it.`,
    )
    if (sleep.busy || now() - lastNap < NAP_COOLDOWN_MS) {
      log(`💀 died${how} at ${position}`)
      return
    }
    lastNap = now()
    log(`💀 died${how} at ${position} — reflecting`)
    sleep.run('death').catch((err: unknown) => log(`⚠ reflecting on the death failed: ${errorMessage(err)}`))
  }

  const onMessage = (message: string, _position: string, json: unknown): void => {
    const key = (json as { translate?: unknown } | null)?.translate
    const prefix = `${bot.username} `
    if (typeof key !== 'string' || !key.startsWith('death.') || !message.startsWith(prefix)) return
    // "was shot by Skeleton" reads as "died (shot by Skeleton)"; "drowned", "fell from a high place" stay as they are.
    const cause = message.slice(prefix.length).replace(/^was /, '')
    if (pending) {
      clearTimeout(pending.timer)
      record(pending.position, pending.lost, cause)
    } else lastCause = { cause, at: now() }
  }

  const onDeath = (): void => {
    if (pending) return
    const position = formatPos(bot.entity.position)
    // Read now: the server empties the inventory right after.
    const lost = describeItems(bot.inventory.items())
    if (lastCause && now() - lastCause.at <= waitMs) return record(position, lost, lastCause.cause)
    pending = { position, lost, timer: setTimeout(() => record(position, lost, null), waitMs) }
  }

  bot.on('messagestr', onMessage)
  bot.on('death', onDeath)
  return () => {
    if (pending) clearTimeout(pending.timer)
    bot.removeListener('messagestr', onMessage)
    bot.removeListener('death', onDeath)
  }
}
