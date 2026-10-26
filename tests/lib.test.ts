import vm from 'node:vm'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { Mutex } from '../src/lib/mutex.ts'
import { errorMessage, truncate } from '../src/lib/text.ts'

describe('truncate', () => {
  it('keeps short text and shortens long text with an ellipsis', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdef', 4)).toBe('abc…')
  })
})

describe('errorMessage', () => {
  it('reads messages from errors of any realm and collapses whitespace', () => {
    expect(errorMessage(new Error('a\n  b'))).toBe('a b')
    expect(errorMessage(vm.runInNewContext('new Error("from vm")'))).toBe('from vm')
    expect(errorMessage('plain')).toBe('plain')
  })
})

describe('Mutex', () => {
  it('runs functions one at a time in call order, even after failures', async () => {
    const mutex = new Mutex()
    const order: string[] = []
    const a = mutex.run(async () => { await sleep(20); order.push('a') })
    const b = mutex.run(async () => { order.push('b'); throw new Error('b failed') })
    const c = mutex.run(async () => { order.push('c'); return 'c' })
    await a
    await expect(b).rejects.toThrow('b failed')
    expect(await c).toBe('c')
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('isHostile', () => {
  it('accepts hostile-typed entities and the explicit mob names', async () => {
    const { isHostile } = await import('../src/lib/mc.ts')
    expect(isHostile({ type: 'hostile', name: 'zombie' } as never)).toBe(true)
    expect(isHostile({ type: 'mob', name: 'slime' } as never)).toBe(true)
    expect(isHostile({ type: 'mob', name: 'phantom' } as never)).toBe(true)
    expect(isHostile({ type: 'mob', name: 'cow' } as never)).toBe(false)
    expect(isHostile({ type: 'player', name: 'Steve' } as never)).toBe(false)
  })
})

describe('moveTo', () => {
  /** A bot whose pathfinder never finishes on its own: goto settles only when the goal is cleared. */
  async function stuckBot(move: (tick: number) => [number, number, number] = () => [0, 64, 0]) {
    const { Vec3 } = await import('../src/lib/mc.ts')
    let reject: (err: Error) => void = () => {}
    let tick = 0
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      pathfinder: {
        isMining: () => false,
        isBuilding: () => false,
        goto: () => new Promise<void>((_, r) => (reject = r)),
        setGoal: (goal: unknown) => goal === null && reject(new Error('GoalChanged')),
      },
    }
    const timer = setInterval(() => (bot.entity.position = new Vec3(...move(++tick))), 1_000)
    return { bot: bot as never, stop: () => clearInterval(timer) }
  }

  it('gives up with an UnreachableError when the bot stops making progress', async () => {
    vi.useFakeTimers()
    try {
      const { moveTo, UnreachableError, goals } = await import('../src/lib/mc.ts')
      const { bot, stop } = await stuckBot()
      const moving = moveTo(bot, new goals.GoalNearXZ(80, 0, 3), new AbortController().signal)
      const result = expect(moving).rejects.toThrow(/stuck at 0 64 0/)
      await vi.advanceTimersByTimeAsync(15_000)
      await result
      await expect(moving).rejects.toBeInstanceOf(UnreachableError)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps going while the bot is moving, however long it takes', async () => {
    vi.useFakeTimers()
    try {
      const { moveTo, goals } = await import('../src/lib/mc.ts')
      const { bot, stop } = await stuckBot((t) => [t, 64, 0])
      let settled = false
      const moving = moveTo(bot, new goals.GoalNearXZ(500, 0, 3), new AbortController().signal).finally(() => (settled = true))
      moving.catch(() => {})
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
