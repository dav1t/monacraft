import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { remapChunk, stateRemap } from '../src/web/blockRemap.ts'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const Registry = require('prismarine-registry')
const newer = Registry('1.21.11')
const older = Registry('1.21.4')
const Block = require('prismarine-block')
const NewBlock = Block(newer)
const OldBlock = Block(older)
const NewChunk = require('prismarine-chunk')(newer)
const OldChunk = require('prismarine-chunk')(older)

const map = stateRemap(newer.blocksArray, older.blocksArray)

function oldBlockFor(name: string, properties: Record<string, unknown>): { name: string; properties: Record<string, unknown> } {
  const block = OldBlock.fromStateId(map[NewBlock.fromProperties(name, properties).stateId])
  return { name: block.name, properties: block.getProperties() }
}

describe('stateRemap', () => {
  it('keeps the block and its properties', () => {
    expect(oldBlockFor('stone', {}).name).toBe('stone')
    const stairs = { facing: 'east', half: 'top', shape: 'outer_left', waterlogged: true }
    expect(oldBlockFor('oak_stairs', stairs)).toEqual({ name: 'oak_stairs', properties: stairs })
    expect(oldBlockFor('cherry_log', { axis: 'x' })).toEqual({ name: 'cherry_log', properties: { axis: 'x' } })
  })

  it('turns blocks the older version lacks into air', () => {
    expect(oldBlockFor('leaf_litter', { facing: 'north', segment_amount: 2 }).name).toBe('air')
  })
})

describe('remapChunk', () => {
  const nameOf = (stateId: number): string => older.blocks[older.blocksByStateId[stateId].id].name

  it('rewrites single-value and palette sections', () => {
    const column = new NewChunk({ minY: -64, worldHeight: 384 })
    column.setBlockStateId(new Vec3(3, 70, 5), newer.blocksByName.oak_log.defaultState)
    column.setBlockStateId(new Vec3(3, 71, 5), newer.blocksByName.leaf_litter.defaultState)

    const result = OldChunk.fromJson(remapChunk(column.toJson(), map))
    expect(nameOf(result.getBlockStateId(new Vec3(3, 70, 5)))).toBe('oak_log')
    expect(nameOf(result.getBlockStateId(new Vec3(3, 71, 5)))).toBe('air')
    expect(nameOf(result.getBlockStateId(new Vec3(8, 200, 8)))).toBe('air')
  })

  it('rewrites direct (global id) sections', () => {
    // prismarine-chunk cannot read its own direct-section JSON back, so the packed ids are checked directly.
    const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan')
    const column = new NewChunk({ minY: -64, worldHeight: 384 })
    const blocks = newer.blocksArray.slice(0, 400)
    blocks.forEach((b: { defaultState: number }, i: number) => column.setBlockStateId(new Vec3(i & 15, i >> 8, (i >> 4) & 15), b.defaultState))

    const section = (json: string): { type: string; data: string } => JSON.parse(JSON.parse(JSON.parse(json).sections[4]).data)
    const packed = section(remapChunk(column.toJson(), map))
    expect(packed.type).toBe('direct')
    const bits = BitArray.fromJson(packed.data)
    blocks.forEach((b: { defaultState: number }, i: number) => expect(bits.get(i)).toBe(map[b.defaultState]))
  })
})
