import { describe, expect, it } from 'vitest'
import { DamageSense, describeHit, type Hit } from '../src/damage.ts'

const at = { x: 0, y: 64, z: 0 }
const skeleton = { label: 'skeleton', position: { x: 13, y: 64, z: -13 } }

describe('describeHit', () => {
  it('names the attacker, how and where it is', () => {
    expect(describeHit({ type: 'arrow', attacker: skeleton, position: at, health: 14 })).toBe('hurt by skeleton (arrow, 18m NE) — health 14')
  })

  it('leaves out a plain melee hit', () => {
    expect(describeHit({ type: 'mob_attack', attacker: { label: 'zombie', position: { x: 0, y: 64, z: 2 } }, position: at, health: 17 })).toBe(
      'hurt by zombie (2m S) — health 17',
    )
  })

  it('says what happened when nobody did it', () => {
    expect(describeHit({ type: 'drown', position: at, health: 12 })).toBe('you are drowning — health 12')
    expect(describeHit({ type: 'fall', position: at, health: 16.5 })).toBe('you took fall damage — health 17')
    expect(describeHit({ type: 'wither_skull_impact', position: at, health: 9 })).toBe('you took wither skull impact damage — health 9')
  })
})

describe('DamageSense', () => {
  const drown: Hit = { type: 'drown', position: at, health: 18 }

  it('notes a cause once in 10s and interrupts for it once in 30s', () => {
    const sense = new DamageSense()
    expect(sense.hurt(drown, 0)).toEqual({ note: 'you are drowning — health 18', interrupt: true })
    expect(sense.hurt(drown, 1_000)).toEqual({ note: null, interrupt: false })
    expect(sense.hurt(drown, 10_000)).toEqual({ note: 'you are drowning — health 18', interrupt: false })
    expect(sense.hurt(drown, 30_000).interrupt).toBe(true)
  })

  it('treats another cause or attacker as news', () => {
    const sense = new DamageSense()
    sense.hurt(drown, 0)
    expect(sense.hurt({ type: 'arrow', attacker: skeleton, position: at, health: 15 }, 500).interrupt).toBe(true)
    expect(sense.hurt({ type: 'arrow', attacker: { ...skeleton, label: 'stray' }, position: at, health: 12 }, 600).interrupt).toBe(true)
  })
})
