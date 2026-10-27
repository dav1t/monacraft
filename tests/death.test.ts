import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/database.ts'
import { createRepos, type Day, type DayKind } from '../src/db/repos.ts'
import { watchDeaths, type DeathBot } from '../src/death.ts'

function setup({ busy = false } = {}) {
  const bot = Object.assign(new EventEmitter(), { username: 'MonaCraft1', entity: { position: { x: 23.4, y: 69, z: -714.6 } } })
  const repos = createRepos(openDatabase(':memory:'))
  const naps: DayKind[] = []
  const sleep = { busy, run: async (kind: DayKind) => (naps.push(kind), {} as Day) }
  const logs: string[] = []
  let now = 0
  const stop = watchDeaths({ bot: bot as unknown as DeathBot, repos, sleep, log: (l) => logs.push(l), waitMs: 20, now: () => now })
  const deathMessage = (text: string) => bot.emit('messagestr', text, 'system', { translate: 'death.attack.arrow' })
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  return { bot, repos, naps, logs, stop, deathMessage, later, setNow: (t: number) => (now = t) }
}

const lastEvent = (repos: ReturnType<typeof createRepos>) => repos.history.recent(1)[0]?.content

describe('watchDeaths', () => {
  it('records the cause from the death message that follows, then reflects on it', async () => {
    const { bot, repos, naps, logs, deathMessage, later } = setup()
    bot.emit('death')
    deathMessage('MonaCraft1 was shot by Skeleton')
    await later(40)
    expect(lastEvent(repos)).toBe('you died (shot by Skeleton) at 23 69 -715 and respawned; your items dropped there. Think about what killed you and how to avoid it.')
    expect(logs).toContain('💀 died (shot by Skeleton) at 23 69 -715 — reflecting')
    expect(naps).toEqual(['nap'])
  })

  it('uses a death message that arrived just before the death event', async () => {
    const { bot, repos, deathMessage, later } = setup()
    deathMessage('MonaCraft1 was blown up by Creeper')
    bot.emit('death')
    await later(40)
    expect(lastEvent(repos)).toContain('you died (blown up by Creeper) at 23 69 -715')
  })

  it('still records the death when no message names the cause', async () => {
    const { bot, repos, deathMessage, later } = setup()
    deathMessage('Dav1tt was slain by Zombie')
    bot.emit('messagestr', 'MonaCraft1 joined the game', 'system', { translate: 'multiplayer.player.joined' })
    bot.emit('death')
    await later(40)
    expect(lastEvent(repos)).toMatch(/^you died at 23 69 -715 and respawned/)
  })

  it('reflects at most once every few minutes, and not while already reflecting', async () => {
    const first = setup()
    first.bot.emit('death')
    await first.later(40)
    first.setNow(60_000)
    first.bot.emit('death')
    await first.later(40)
    expect(first.naps).toEqual(['nap'])
    first.setNow(10 * 60_000)
    first.bot.emit('death')
    await first.later(40)
    expect(first.naps).toEqual(['nap', 'nap'])

    const busy = setup({ busy: true })
    busy.bot.emit('death')
    await busy.later(40)
    expect(busy.naps).toEqual([])
  })

  it('stops listening', async () => {
    const { bot, repos, stop, later } = setup()
    stop()
    bot.emit('death')
    await later(40)
    expect(repos.history.recent(1)).toEqual([])
  })
})
