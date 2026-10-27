import { relative, type Point } from './geometry.ts'

/** A useful block the eyes saw (see eyes.ts). */
export interface SeenBlock {
  name: string
  position: Point
}

export interface EntityInfo {
  /** `zombie`, `player:Steve`, `dropped:oak_log`… */
  label: string
  distance: number
  hostile: boolean
  /** From the bot, e.g. `NE` or `S, below`. */
  direction: string
  /** How the distance changed since the eyes last looked. */
  trend?: 'approaching' | 'moving away'
}

/** The nearest visible block of one useful kind, and how many are visible. */
export interface NotableBlock {
  count: number
  nearest: [number, number, number]
  distance: number
  direction: string
}

/** Item names in hand and worn; empty slots are left out. */
export type Equipped = Partial<Record<'hand' | 'off_hand' | 'head' | 'torso' | 'legs' | 'feet', string>>

/** Raw sensor readings, decoupled from mineflayer so formatting is testable. */
export interface WorldState {
  health: number
  food: number
  xpLevel: number
  position: [number, number, number]
  yaw: number
  biome: string
  timeOfDay: number
  raining: boolean
  equipped: Equipped
  cursorBlock: string | null
  inventory: Record<string, number>
  entities: EntityInfo[]
  blocks: Record<string, number>
  notable: Record<string, NotableBlock>
}

export interface Snapshot {
  health: number
  food: number
  xp_level: number
  position: [number, number, number]
  facing: string
  biome: string
  time: string
  weather: string
  /** In hand and worn. The held item also counts in inventory; worn ones do not. */
  equipped: Equipped
  looking_at: string | null
  inventory: Record<string, number>
  nearby_entities: string[]
  nearby_blocks: Record<string, number>
  /** Where the nearest useful blocks are (ores, logs, chests, lava…). */
  notable_blocks: Record<string, string>
}

export function timeLabel(ticks: number): string {
  const t = ((ticks % 24000) + 24000) % 24000
  if (t < 1000) return 'sunrise'
  if (t < 12000) return 'day'
  if (t < 13000) return 'dusk'
  if (t < 23000) return 'night'
  return 'dawn'
}

export function facingLabel(yaw: number): string {
  const quarter = Math.round(yaw / (Math.PI / 2))
  return ['north', 'west', 'south', 'east'][((quarter % 4) + 4) % 4] as string
}

export function summarizeEntities(entities: EntityInfo[]): string[] {
  const groups = new Map<string, { count: number; nearest: EntityInfo }>()
  for (const e of entities) {
    const group = groups.get(e.label)
    if (group) {
      group.count++
      if (e.distance < group.nearest.distance) group.nearest = e
    } else {
      groups.set(e.label, { count: 1, nearest: e })
    }
  }
  return [...groups]
    .sort(([, a], [, b]) => Number(b.nearest.hostile) - Number(a.nearest.hostile) || a.nearest.distance - b.nearest.distance)
    .map(([label, { count, nearest }]) => {
      const trend = nearest.trend ? `, ${nearest.trend}` : ''
      return `${label}${count > 1 ? ` x${count}` : ''} (${nearest.hostile ? 'hostile, ' : ''}nearest ${Math.round(nearest.distance)}m ${nearest.direction}${trend})`
    })
}

/** Groups seen blocks by kind: how many, and the nearest one as seen from `from`. */
export function groupNotable(blocks: SeenBlock[], from: Point): Record<string, NotableBlock> {
  const notable: Record<string, NotableBlock> = {}
  for (const { name, position } of blocks) {
    const { distance, direction } = relative(from, position)
    const nearest: [number, number, number] = [position.x, position.y, position.z]
    const known = notable[name]
    if (!known) notable[name] = { count: 1, nearest, distance, direction }
    else {
      known.count++
      if (distance < known.distance) Object.assign(known, { nearest, distance, direction })
    }
  }
  return notable
}

/** Nearest first, at most `limit` kinds: `iron_ore: "x3, nearest 14 31 -8 (5m NE, below)"`. */
export function formatNotable(notable: Record<string, NotableBlock>, limit: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(notable)
      .sort(([, a], [, b]) => a.distance - b.distance)
      .slice(0, limit)
      .map(([name, b]) => [name, `${b.count > 1 ? `x${b.count}, ` : ''}nearest ${b.nearest.join(' ')} (${b.distance}m ${b.direction})`]),
  )
}

export function topCounts(counts: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, limit))
}

export function formatSnapshot(s: WorldState): Snapshot {
  return {
    health: s.health,
    food: s.food,
    xp_level: s.xpLevel,
    position: s.position,
    facing: facingLabel(s.yaw),
    biome: s.biome,
    time: timeLabel(s.timeOfDay),
    weather: s.raining ? 'rain' : 'clear',
    equipped: s.equipped,
    looking_at: s.cursorBlock,
    inventory: s.inventory,
    nearby_entities: summarizeEntities(s.entities),
    nearby_blocks: topCounts(s.blocks, 15),
    notable_blocks: formatNotable(s.notable, 12),
  }
}
