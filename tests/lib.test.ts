import vm from 'node:vm'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
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
