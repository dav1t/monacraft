import type { DatabaseSync } from 'node:sqlite'

export interface StoredContainer {
  /** `chest`, `barrel`… */
  block: string
  x: number
  y: number
  z: number
  /** Item counts as last seen inside. */
  items: Record<string, number>
  updated_at: string
}

type Row = Omit<StoredContainer, 'items'> & { items: string }

/** What is in the chests the bot opened, so it knows what it put away without walking back to look. */
export class ContainerRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get(x: number, y: number, z: number): StoredContainer | undefined {
    const row = this.#db.prepare('SELECT * FROM containers WHERE x = ? AND y = ? AND z = ?').get(x, y, z) as unknown as Row | undefined
    return row && parse(row)
  }

  /** Most recently opened first. */
  list(): StoredContainer[] {
    return (this.#db.prepare('SELECT * FROM containers ORDER BY updated_at DESC, x, y, z').all() as unknown as Row[]).map(parse)
  }

  save(c: Omit<StoredContainer, 'updated_at'>): void {
    this.#db
      .prepare(`INSERT INTO containers (x, y, z, block, items) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(x, y, z) DO UPDATE SET block = excluded.block, items = excluded.items, updated_at = datetime('now')`)
      .run(c.x, c.y, c.z, c.block, JSON.stringify(c.items))
  }

  delete(x: number, y: number, z: number): boolean {
    return Number(this.#db.prepare('DELETE FROM containers WHERE x = ? AND y = ? AND z = ?').run(x, y, z).changes) > 0
  }
}

function parse(row: Row): StoredContainer {
  return { ...row, items: JSON.parse(row.items) as Record<string, number> }
}

export function describeContainer(c: Pick<StoredContainer, 'block' | 'x' | 'y' | 'z' | 'items'>): string {
  const items = Object.entries(c.items).sort(([, a], [, b]) => b - a)
  return `${c.block} at ${c.x} ${c.y} ${c.z}: ${items.length > 0 ? items.map(([name, n]) => `${name} x${n}`).join(', ') : 'empty'}`
}
