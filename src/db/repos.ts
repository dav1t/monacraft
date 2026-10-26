import type { DatabaseSync } from 'node:sqlite'

export interface Skill {
  name: string
  description: string
  code: string
  successes: number
  failures: number
}

export type HistoryKind = 'action' | 'chat' | 'event'

export interface HistoryEntry {
  id: number
  kind: HistoryKind
  content: string
  created_at: string
}

const SKILL_COLUMNS = 'name, description, code, successes, failures'

export class SkillRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get(name: string): Skill | undefined {
    return this.#db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE name = ?`).get(name) as unknown as Skill | undefined
  }

  list(): Skill[] {
    return this.#db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills ORDER BY name`).all() as unknown as Skill[]
  }

  create(skill: Pick<Skill, 'name' | 'description' | 'code'>): void {
    this.#db.prepare('INSERT INTO skills (name, description, code) VALUES (?, ?, ?)').run(skill.name, skill.description, skill.code)
  }

  update(name: string, changes: { code: string; description?: string }): boolean {
    const result = this.#db
      .prepare(`UPDATE skills SET code = ?, description = COALESCE(?, description), updated_at = datetime('now') WHERE name = ?`)
      .run(changes.code, changes.description ?? null, name)
    return Number(result.changes) > 0
  }

  recordResult(name: string, ok: boolean): void {
    const column = ok ? 'successes' : 'failures'
    this.#db.prepare(`UPDATE skills SET ${column} = ${column} + 1 WHERE name = ?`).run(name)
  }
}

export class MemoryRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  set(key: string, value: string): void {
    this.#db
      .prepare(`INSERT INTO memory (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(key, value)
  }

  delete(key: string): boolean {
    return Number(this.#db.prepare('DELETE FROM memory WHERE key = ?').run(key).changes) > 0
  }

  all(): Record<string, string> {
    const rows = this.#db.prepare('SELECT key, value FROM memory ORDER BY key').all() as unknown as { key: string; value: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }
}

export class HistoryRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  add(kind: HistoryKind, content: string): void {
    this.#db.prepare('INSERT INTO history (kind, content) VALUES (?, ?)').run(kind, content)
  }

  /** The last `limit` entries, oldest first. */
  recent(limit: number): HistoryEntry[] {
    return this.#db
      .prepare('SELECT * FROM (SELECT id, kind, content, created_at FROM history ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(limit) as unknown as HistoryEntry[]
  }
}

export interface Repos {
  skills: SkillRepo
  memory: MemoryRepo
  history: HistoryRepo
}

export function createRepos(db: DatabaseSync): Repos {
  return { skills: new SkillRepo(db), memory: new MemoryRepo(db), history: new HistoryRepo(db) }
}
