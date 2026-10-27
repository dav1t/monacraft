// The POV viewer only ships textures/data up to some Minecraft version; newer servers send block state ids that mean
// different blocks there (ids shift whenever blocks are added). These helpers translate ids between versions.

interface StateData {
  name: string
  type: string
  num_values: number
  values?: string[]
}

export interface BlockData {
  name: string
  minStateId: number
  maxStateId: number
  defaultState: number
  states?: StateData[]
}

function valueName(state: StateData, index: number): string {
  if (state.values) return state.values[index] ?? String(index)
  if (state.type === 'bool') return index === 0 ? 'true' : 'false'
  return String(index)
}

/** Property value indices of a block's state offset; the last property varies fastest (as in prismarine-block). */
function decode(states: StateData[], offset: number): number[] {
  const indices = new Array<number>(states.length)
  for (let i = states.length - 1; i >= 0; i--) {
    indices[i] = offset % states[i]!.num_values
    offset = Math.floor(offset / states[i]!.num_values)
  }
  return indices
}

/**
 * For every state id of `from`, the id of the same block with the same properties in `to`. Properties `to` lacks
 * are dropped, ones it adds take its default; blocks `to` does not have become air (0).
 */
export function stateRemap(from: BlockData[], to: BlockData[]): Uint32Array {
  const target = new Map(to.map((b) => [b.name, b]))
  const map = new Uint32Array(Math.max(...from.map((b) => b.maxStateId)) + 1)
  for (const block of from) {
    const other = target.get(block.name)
    if (!other) continue
    const states = block.states ?? []
    const otherStates = other.states ?? []
    const defaults = decode(otherStates, other.defaultState - other.minStateId)
    for (let id = block.minStateId; id <= block.maxStateId; id++) {
      const indices = decode(states, id - block.minStateId)
      const props = new Map(states.map((s, i) => [s.name, valueName(s, indices[i]!)]))
      let offset = 0
      otherStates.forEach((s, i) => {
        const wanted = props.get(s.name)
        let index = defaults[i]!
        for (let v = 0; wanted !== undefined && v < s.num_values; v++) {
          if (valueName(s, v) === wanted) index = v
        }
        offset = offset * s.num_values + index
      })
      map[id] = other.minStateId + offset
    }
  }
  return map
}

// Direct (global palette) sections store ids in 64-bit longs as pairs of uint32, values never span two longs.
interface BitArrayJson {
  data: number[]
  capacity: number
  bitsPerValue: number
  valuesPerLong: number
  valueMask: number
}

function bitGet(a: BitArrayJson, index: number): number {
  const long = Math.floor(index / a.valuesPerLong)
  const bit = (index - long * a.valuesPerLong) * a.bitsPerValue
  if (bit >= 32) return (a.data[long * 2 + 1]! >>> (bit - 32)) & a.valueMask
  let result = a.data[long * 2]! >>> bit
  if (bit + a.bitsPerValue > 32) result |= a.data[long * 2 + 1]! << (32 - bit)
  return result & a.valueMask
}

function bitSet(a: BitArrayJson, index: number, value: number): void {
  const long = Math.floor(index / a.valuesPerLong)
  const bit = (index - long * a.valuesPerLong) * a.bitsPerValue
  if (bit >= 32) {
    const at = long * 2 + 1
    a.data[at] = ((a.data[at]! & ~(a.valueMask << (bit - 32))) | ((value & a.valueMask) << (bit - 32))) >>> 0
    return
  }
  const at = long * 2
  a.data[at] = ((a.data[at]! & ~(a.valueMask << bit)) | ((value & a.valueMask) << bit)) >>> 0
  const end = bit + a.bitsPerValue
  if (end > 32) a.data[at + 1] = ((a.data[at + 1]! & ~((1 << (end - 32)) - 1)) | (value >> (32 - bit))) >>> 0
}

function remapContainer(json: string, map: ArrayLike<number>): string {
  const container = JSON.parse(json) as { type: string; value?: number; palette?: number[]; data?: string }
  const to = (id: number): number => map[id] ?? 0
  if (container.type === 'single') container.value = to(container.value ?? 0)
  else if (container.type === 'indirect') container.palette = container.palette!.map(to)
  else if (container.type === 'direct') {
    const bits = JSON.parse(container.data!) as BitArrayJson
    for (let i = 0; i < bits.capacity; i++) bitSet(bits, i, to(bitGet(bits, i)))
    container.data = JSON.stringify(bits)
  }
  return JSON.stringify(container)
}

/** Rewrites the block state ids of a prismarine-chunk (1.18+) column JSON. Biomes and light stay as they are. */
export function remapChunk(json: string, map: ArrayLike<number>): string {
  const column = JSON.parse(json) as { sections: string[] }
  column.sections = column.sections.map((s) => {
    const section = JSON.parse(s) as { data: string }
    section.data = remapContainer(section.data, map)
    return JSON.stringify(section)
  })
  return JSON.stringify(column)
}
