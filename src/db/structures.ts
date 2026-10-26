import type { DatabaseSync } from 'node:sqlite'
import type { Facing, Shape } from '../building/shapes.ts'

export interface Structure {
  name: string
  shape: Shape
  block: string
  /** Front-left corner. */
  x: number
  y: number
  z: number
  /** Direction from the front (door side) to the back. */
  facing: Facing
  width: number
  depth: number
  height: number
  /** Blocks in the plan, and how many were in place after the last build. */
  total: number
  placed: number
  status: 'building' | 'complete'
  created_at: string
  updated_at: string
}

/** What the bot built, so it knows later (and the reflection cannot invent a shelter that isn't there). */
export class StructureRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get(name: string): Structure | undefined {
    return this.#db.prepare('SELECT * FROM structures WHERE name = ?').get(name) as unknown as Structure | undefined
  }

  /** Most recently built first. */
  list(): Structure[] {
    return this.#db.prepare('SELECT * FROM structures ORDER BY updated_at DESC, name').all() as unknown as Structure[]
  }

  save(s: Omit<Structure, 'created_at' | 'updated_at'>): void {
    this.#db
      .prepare(`INSERT INTO structures (name, shape, block, x, y, z, facing, width, depth, height, total, placed, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET block = excluded.block, total = excluded.total, placed = excluded.placed,
                  status = excluded.status, updated_at = datetime('now')`)
      .run(s.name, s.shape, s.block, s.x, s.y, s.z, s.facing, s.width, s.depth, s.height, s.total, s.placed, s.status)
  }

  delete(name: string): boolean {
    return Number(this.#db.prepare('DELETE FROM structures WHERE name = ?').run(name).changes) > 0
  }
}

export function describeStructure(s: Structure): string {
  const size = s.shape === 'pillar' ? `${s.height} high` : s.shape === 'floor' ? `${s.width}x${s.depth}` : `${s.width}x${s.depth}x${s.height}`
  const state = s.status === 'complete' ? 'complete' : `unfinished, ${s.placed}/${s.total} blocks`
  const door = s.shape === 'shelter' ? `, door on the ${opposite(s.facing)} side` : ''
  return `${s.name}: ${s.shape} ${size} of ${s.block} at ${s.x} ${s.y} ${s.z}${door} (${state})`
}

const OPPOSITE: Record<Facing, Facing> = { north: 'south', south: 'north', east: 'west', west: 'east' }
const opposite = (f: Facing): Facing => OPPOSITE[f]
