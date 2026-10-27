import { describe, expect, it } from 'vitest'
import { Eyes, type SeenEntity, type View } from '../src/eyes.ts'

const me = { x: 0, y: 64, z: 0 }
const zombie = (z: number, id = 1): SeenEntity => ({ id, label: 'zombie', hostile: true, neutral: false, player: false, position: { x: 0, y: 64, z } })
const view = (patch: Partial<View> = {}): View => ({ health: 20, position: me, entities: [], lavaNear: false, ...patch })

describe('Eyes', () => {
  it('announces a hostile once when it comes within range, with where it is', () => {
    const eyes = new Eyes()
    expect(eyes.look(view({ entities: [zombie(-30)] }), 0).events).toEqual([])
    expect(eyes.look(view({ entities: [zombie(-14)] }), 500).events).toEqual(['zombie appeared 14m N'])
    expect(eyes.look(view({ entities: [zombie(-13)] }), 1000).events).toEqual([])
  })

  it('tracks whether things approach or move away', () => {
    const eyes = new Eyes()
    eyes.look(view({ entities: [zombie(-14)] }), 0)
    eyes.look(view({ entities: [zombie(-12)] }), 500)
    expect(eyes.trendOf(1)).toBe('approaching')
    eyes.look(view({ entities: [zombie(-15)] }), 1000)
    expect(eyes.trendOf(1)).toBe('moving away')
    eyes.look(view({ entities: [zombie(-15.1)] }), 1500)
    expect(eyes.trendOf(1)).toBeUndefined()
  })

  it('interrupts when a hostile closes in, but only once in a while for the same mob', () => {
    const eyes = new Eyes()
    eyes.look(view({ entities: [zombie(-12)] }), 0)
    expect(eyes.look(view({ entities: [zombie(-9)] }), 500).urgent).toBe('zombie closing in from N (9m)')
    expect(eyes.look(view({ entities: [zombie(-8)] }), 1000).urgent).toBeNull()
    expect(eyes.look(view({ entities: [zombie(-7)] }), 21_000).urgent).toBe('zombie closing in from N (7m)')
  })

  it('does not interrupt for neutral mobs or ones keeping their distance', () => {
    const eyes = new Eyes()
    const enderman = (z: number): SeenEntity => ({ ...zombie(z, 2), label: 'enderman', neutral: true })
    eyes.look(view({ entities: [enderman(-12), zombie(-8)] }), 0)
    expect(eyes.look(view({ entities: [enderman(-6), zombie(-8)] }), 500).urgent).toBeNull()
  })

  it('reports players coming and going', () => {
    const eyes = new Eyes()
    const dav = (z: number): SeenEntity => ({ id: 7, label: 'player:Dav1tt', hostile: false, neutral: false, player: true, position: { x: 0, y: 64, z } })
    expect(eyes.look(view({ entities: [dav(20)] }), 0).events).toEqual(['Dav1tt came near (20m S)'])
    expect(eyes.look(view({ entities: [dav(36)] }), 500).events).toEqual([])
    expect(eyes.look(view({ entities: [] }), 1000).events).toEqual(['Dav1tt left'])
  })

  it('reports health drops of 4 or more, and interrupts when health is low', () => {
    const eyes = new Eyes()
    eyes.look(view({ health: 20 }), 0)
    expect(eyes.look(view({ health: 18 }), 500).events).toEqual([])
    expect(eyes.look(view({ health: 15 }), 1000)).toEqual({ events: ['health fell to 15 (was 20)'], urgent: null })
    expect(eyes.look(view({ health: 6 }), 1500)).toEqual({ events: ['health fell to 6 (was 15)'], urgent: 'health is low (6)' })
    eyes.look(view({ health: 20 }), 2000)
    expect(eyes.look(view({ health: 16 }), 2500).events).toEqual(['health fell to 16 (was 20)'])
  })

  it('interrupts for lava next to the bot', () => {
    const eyes = new Eyes()
    expect(eyes.look(view({ lavaNear: true }), 0).urgent).toBe('lava right next to you')
    expect(eyes.look(view({ lavaNear: true }), 5_000).urgent).toBeNull()
  })

  it('announces each rare ore position once and keeps the useful blocks it last saw', () => {
    const eyes = new Eyes()
    const diamond = { name: 'diamond_ore', position: { x: 9, y: 11, z: 0 } }
    const log = { name: 'oak_log', position: { x: 2, y: 64, z: 2 } }
    expect(eyes.look(view({ notable: [diamond, log] }), 0).events).toEqual(['spotted diamond_ore at 9 11 0 (54m E, below)'])
    expect(eyes.look(view(), 500).events).toEqual([])
    expect(eyes.notable).toEqual([diamond, log])
    expect(eyes.look(view({ notable: [diamond] }), 4000).events).toEqual([])
    expect(eyes.notable).toEqual([diamond])
  })
})
