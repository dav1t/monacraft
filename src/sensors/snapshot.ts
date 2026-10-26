export interface EntityInfo {
  /** `zombie`, `player:Steve`, `dropped:oak_log`… */
  label: string
  distance: number
  hostile: boolean
}

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
  held: string | null
  armor: string[]
  cursorBlock: string | null
  inventory: Record<string, number>
  entities: EntityInfo[]
  blocks: Record<string, number>
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
  held: string | null
  armor: string[]
  looking_at: string | null
  inventory: Record<string, number>
  nearby_entities: string[]
  nearby_blocks: Record<string, number>
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
  const groups = new Map<string, { count: number; nearest: number; hostile: boolean }>()
  for (const e of entities) {
    const group = groups.get(e.label)
    if (group) {
      group.count++
      group.nearest = Math.min(group.nearest, e.distance)
    } else {
      groups.set(e.label, { count: 1, nearest: e.distance, hostile: e.hostile })
    }
  }
  return [...groups]
    .sort(([, a], [, b]) => Number(b.hostile) - Number(a.hostile) || a.nearest - b.nearest)
    .map(([label, g]) => `${label}${g.count > 1 ? ` x${g.count}` : ''} (${g.hostile ? 'hostile, ' : ''}nearest ${Math.round(g.nearest)}m)`)
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
    held: s.held,
    armor: s.armor,
    looking_at: s.cursorBlock,
    inventory: s.inventory,
    nearby_entities: summarizeEntities(s.entities),
    nearby_blocks: topCounts(s.blocks, 15),
  }
}
