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

  delete(name: string): boolean {
    return Number(this.#db.prepare('DELETE FROM skills WHERE name = ?').run(name).changes) > 0
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

  /** Up to `limit` entries older than `beforeId` (all if omitted), newest first. */
  page(limit: number, beforeId?: number): HistoryEntry[] {
    return this.#db
      .prepare('SELECT id, kind, content, created_at FROM history WHERE id < ? ORDER BY id DESC LIMIT ?')
      .all(beforeId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as HistoryEntry[]
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM history WHERE id = ?').run(id).changes) > 0
  }

  clear(): void {
    this.#db.exec('DELETE FROM history')
  }
}

export interface Revelation {
  id: number
  content: string
  created_at: string
}

/** Guidance written by the player in the panel; shown to the agent above everything else until deleted. */
export class RevelationRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  add(content: string): Revelation {
    return this.#db
      .prepare('INSERT INTO revelations (content) VALUES (?) RETURNING id, content, created_at')
      .get(content) as unknown as Revelation
  }

  update(id: number, content: string): boolean {
    return Number(this.#db.prepare('UPDATE revelations SET content = ? WHERE id = ?').run(content, id).changes) > 0
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM revelations WHERE id = ?').run(id).changes) > 0
  }

  list(): Revelation[] {
    return this.#db.prepare('SELECT id, content, created_at FROM revelations ORDER BY id').all() as unknown as Revelation[]
  }
}

export interface Repos {
  skills: SkillRepo
  memory: MemoryRepo
  history: HistoryRepo
  revelations: RevelationRepo
}

export function createRepos(db: DatabaseSync): Repos {
  return { skills: new SkillRepo(db), memory: new MemoryRepo(db), history: new HistoryRepo(db), revelations: new RevelationRepo(db) }
}
