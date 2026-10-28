import type { DatabaseSync } from 'node:sqlite'
import { ContainerRepo } from './containers.ts'
import { DayRepo, LessonRepo } from './days.ts'
import { GoalRepo, TemplateRepo } from './goals.ts'
import { IdentityRepo, ScarRepo } from './identity.ts'
import { StructureRepo } from './structures.ts'
import { UsageRepo } from './usage.ts'

export type { StoredContainer } from './containers.ts'
export type { Day, DayKind, Lesson, LessonSource } from './days.ts'
export type { Identity, IdentityReason, Scar } from './identity.ts'
export type { Structure } from './structures.ts'
export type { ModelStats } from './usage.ts'
export type { GoalKind, GoalRow, GoalStatus, PlanTemplate, TemplateKind } from './goals.ts'

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

export interface MemoryEntry {
  key: string
  value: string
  pinned: boolean
  updated_at: string
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

  /** Pinned facts first, then the most recently updated. */
  list(): MemoryEntry[] {
    const rows = this.#db
      .prepare('SELECT key, value, pinned, updated_at FROM memory ORDER BY pinned DESC, updated_at DESC, key')
      .all() as unknown as (Omit<MemoryEntry, 'pinned'> & { pinned: number })[]
    return rows.map((r) => ({ ...r, pinned: r.pinned === 1 }))
  }

  /** Pinned facts are never deleted or changed by sleep. */
  setPinned(key: string, pinned: boolean): boolean {
    return Number(this.#db.prepare('UPDATE memory SET pinned = ? WHERE key = ?').run(pinned ? 1 : 0, key).changes) > 0
  }

  isPinned(key: string): boolean {
    return (this.#db.prepare('SELECT pinned FROM memory WHERE key = ?').get(key) as { pinned: number } | undefined)?.pinned === 1
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

  /** The last `limit` entries (only those after `afterId`), oldest first. */
  recent(limit: number, afterId = 0): HistoryEntry[] {
    return this.#db
      .prepare('SELECT * FROM (SELECT id, kind, content, created_at FROM history WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(afterId, limit) as unknown as HistoryEntry[]
  }

  countSince(afterId: number): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM history WHERE id > ?').get(afterId) as { n: number }).n
  }

  lastId(): number {
    return (this.#db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM history').get() as { id: number }).id
  }

  /**
   * Entries containing any of `terms` (case-insensitive), newest first. Candidates for recall; the caller ranks them.
   */
  search(terms: string[], limit: number): HistoryEntry[] {
    if (terms.length === 0) return []
    const where = terms.map(() => 'content LIKE ?').join(' OR ')
    return this.#db
      .prepare(`SELECT id, kind, content, created_at FROM history WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...terms.map((t) => `%${t}%`), limit) as unknown as HistoryEntry[]
  }

  /** When the first entry after `afterId` was written (the start of a day), if any. */
  firstTimeSince(afterId: number): string | null {
    return (this.#db.prepare('SELECT MIN(created_at) AS t FROM history WHERE id > ?').get(afterId) as { t: string | null }).t
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
  goals: GoalRepo
  templates: TemplateRepo
  days: DayRepo
  lessons: LessonRepo
  identity: IdentityRepo
  scars: ScarRepo
  structures: StructureRepo
  containers: ContainerRepo
  usage: UsageRepo
  /** Runs `fn` in one transaction; it is rolled back if `fn` throws. */
  transaction<T>(fn: () => T): T
}

export function createRepos(db: DatabaseSync): Repos {
  return {
    skills: new SkillRepo(db),
    memory: new MemoryRepo(db),
    history: new HistoryRepo(db),
    revelations: new RevelationRepo(db),
    goals: new GoalRepo(db),
    templates: new TemplateRepo(db),
    days: new DayRepo(db),
    lessons: new LessonRepo(db),
    identity: new IdentityRepo(db),
    scars: new ScarRepo(db),
    structures: new StructureRepo(db),
    containers: new ContainerRepo(db),
    usage: new UsageRepo(db),
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}
