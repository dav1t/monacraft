import type { DatabaseSync } from 'node:sqlite'

export type DayKind = 'sleep' | 'nap'

export interface Day {
  id: number
  kind: DayKind
  started_at: string
  ended_at: string
  journal: string
  /** The last history entry of the day; the next day's prompt history starts after it. */
  history_until: number
  /** Skills the reflection found failing, for the player to look at. */
  skills_review: string[]
}

type DayRow = Omit<Day, 'skills_review'> & { skills_review: string }

const toDay = ({ skills_review, ...rest }: DayRow): Day => ({ ...rest, skills_review: JSON.parse(skills_review) as string[] })

/** One row per sleep or nap: the journal of the day that ended. */
export class DayRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  add(day: { kind: DayKind; startedAt: string; journal: string; historyUntil: number; skillsReview: string[] }): Day {
    const row = this.#db
      .prepare(`INSERT INTO days (kind, started_at, journal, history_until, skills_review) VALUES (?, ?, ?, ?, ?) RETURNING *`)
      .get(day.kind, day.startedAt, day.journal, day.historyUntil, JSON.stringify(day.skillsReview)) as unknown as DayRow
    return toDay(row)
  }

  latest(): Day | undefined {
    const row = this.#db.prepare('SELECT * FROM days ORDER BY id DESC LIMIT 1').get() as unknown as DayRow | undefined
    return row && toDay(row)
  }

  /** Newest first. */
  list(limit: number): Day[] {
    return (this.#db.prepare('SELECT * FROM days ORDER BY id DESC LIMIT ?').all(limit) as unknown as DayRow[]).map(toDay)
  }

  /** History entries after this id belong to today. */
  todayAfter(): number {
    return this.latest()?.history_until ?? 0
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM days WHERE id = ?').run(id).changes) > 0
  }
}

export type LessonSource = 'sleep' | 'player'

export interface Lesson {
  id: number
  content: string
  source: LessonSource
  created_at: string
}

/** Short rules the bot learned (written at sleep) or was given (written by the player). */
export class LessonRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** Oldest first. */
  list(): Lesson[] {
    return this.#db.prepare('SELECT id, content, source, created_at FROM lessons ORDER BY id').all() as unknown as Lesson[]
  }

  add(content: string, source: LessonSource): Lesson {
    return this.#db
      .prepare('INSERT INTO lessons (content, source) VALUES (?, ?) RETURNING id, content, source, created_at')
      .get(content, source) as unknown as Lesson
  }

  update(id: number, content: string): boolean {
    return Number(this.#db.prepare('UPDATE lessons SET content = ? WHERE id = ?').run(content, id).changes) > 0
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM lessons WHERE id = ?').run(id).changes) > 0
  }

  /** Replaces the lessons written by sleep; the player's own lessons stay. Unchanged lessons keep their age. */
  replaceLearned(contents: string[]): void {
    const player = new Set(this.list().filter((l) => l.source === 'player').map((l) => l.content))
    const keep = new Set(contents.filter((c) => !player.has(c)))
    for (const lesson of this.list()) {
      if (lesson.source !== 'sleep') continue
      if (keep.has(lesson.content)) keep.delete(lesson.content)
      else this.delete(lesson.id)
    }
    for (const content of keep) this.add(content, 'sleep')
  }
}
