import type { DatabaseSync } from 'node:sqlite'
import { normalizeTitle, overlap } from '../lib/words.ts'

export type GoalKind = 'goal' | 'subgoal' | 'step'
/** paused: a goal set aside for another one; set_goal with its title makes it active again. */
export type GoalStatus = 'todo' | 'active' | 'done' | 'failed' | 'dropped' | 'paused'

export interface GoalRow {
  id: number
  parent_id: number | null
  kind: GoalKind
  title: string
  status: GoalStatus
  position: number
  attempts: number
  note: string | null
  /** Name of the plan template the goal was built from, if any. */
  template: string | null
  created_at: string
  updated_at: string
}

const GOAL_COLUMNS = 'id, parent_id, kind, title, status, position, attempts, note, template, created_at, updated_at'

/** The goal tree: one active goal, its ordered sub-goals, and the steps of each sub-goal. */
export class GoalRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  get(id: number): GoalRow | undefined {
    return this.#db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`).get(id) as unknown as GoalRow | undefined
  }

  /** The active goal, if any. */
  active(): GoalRow | undefined {
    return this.#db
      .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE kind = 'goal' AND status = 'active' ORDER BY id DESC LIMIT 1`)
      .get() as unknown as GoalRow | undefined
  }

  children(parentId: number): GoalRow[] {
    return this.#db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE parent_id = ? ORDER BY position, id`).all(parentId) as unknown as GoalRow[]
  }

  /**
   * A node and everything above it, nearest first. The walk stops at a node it has seen before, so a damaged
   * parent chain (a cycle) cannot loop forever.
   */
  lineage(id: number): GoalRow[] {
    const rows: GoalRow[] = []
    const seen = new Set<number>()
    let row = this.get(id)
    while (row && !seen.has(row.id)) {
      seen.add(row.id)
      rows.push(row)
      row = row.parent_id === null ? undefined : this.get(row.parent_id)
    }
    return rows
  }

  /** Goals set aside for another one, newest first. */
  paused(): GoalRow[] {
    return this.#db
      .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE kind = 'goal' AND status = 'paused' ORDER BY id DESC`)
      .all() as unknown as GoalRow[]
  }

  /** Finished goals, newest first. */
  past(limit: number): GoalRow[] {
    return this.#db
      .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE kind = 'goal' AND status NOT IN ('active', 'paused') ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as GoalRow[]
  }

  create(row: { parentId: number | null; kind: GoalKind; title: string; status?: GoalStatus; template?: string | null }): GoalRow {
    const position =
      row.parentId === null
        ? 0
        : (this.#db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM goals WHERE parent_id = ?').get(row.parentId) as { p: number }).p
    return this.#db
      .prepare(`INSERT INTO goals (parent_id, kind, title, status, position, template) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${GOAL_COLUMNS}`)
      .get(row.parentId, row.kind, row.title, row.status ?? 'todo', position, row.template ?? null) as unknown as GoalRow
  }

  update(id: number, changes: Partial<Pick<GoalRow, 'title' | 'status' | 'attempts' | 'note'>>): boolean {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return this.get(id) !== undefined
    const sets = entries.map(([k]) => `${k} = ?`).join(', ')
    const result = this.#db
      .prepare(`UPDATE goals SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), id)
    return Number(result.changes) > 0
  }

  /** Deletes a node and everything below it. */
  delete(id: number): boolean {
    for (const child of this.children(id)) this.delete(child.id)
    return Number(this.#db.prepare('DELETE FROM goals WHERE id = ?').run(id).changes) > 0
  }

  /** Deletes the children of a node whose status is one of `statuses`. */
  deleteChildren(parentId: number, statuses: GoalStatus[]): void {
    for (const child of this.children(parentId)) if (statuses.includes(child.status)) this.delete(child.id)
  }
}

export type TemplateKind = 'goal' | 'subgoal'

export interface PlanTemplate {
  name: string
  kind: TemplateKind
  pattern: string
  /** Sub-goal titles (goal templates) or step titles (sub-goal templates). */
  titles: string[]
  uses: number
  successes: number
  failures: number
  flagged: boolean
  updated_at: string
}

interface TemplateRow extends Omit<PlanTemplate, 'titles' | 'flagged'> {
  subgoals_json: string
  flagged: number
}

const toTemplate = ({ subgoals_json, flagged, ...rest }: TemplateRow): PlanTemplate => ({
  ...rest,
  titles: JSON.parse(subgoals_json) as string[],
  flagged: flagged === 1,
})

/** Plans that worked, saved by title so a similar goal can reuse them. */
export class TemplateRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  list(): PlanTemplate[] {
    return (this.#db.prepare('SELECT * FROM plan_templates ORDER BY kind, name').all() as unknown as TemplateRow[]).map(toTemplate)
  }

  get(kind: TemplateKind, title: string): PlanTemplate | undefined {
    const row = this.#db.prepare('SELECT * FROM plan_templates WHERE kind = ? AND name = ?').get(kind, normalizeTitle(title)) as unknown as
      | TemplateRow
      | undefined
    return row && toTemplate(row)
  }

  /** Records a plan that just succeeded; an existing template of that name takes the new titles. */
  save(kind: TemplateKind, title: string, titles: string[]): void {
    const name = normalizeTitle(title)
    this.#db
      .prepare(`INSERT INTO plan_templates (name, kind, pattern, subgoals_json, successes) VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(kind, name) DO UPDATE SET subgoals_json = excluded.subgoals_json, successes = successes + 1,
                  flagged = 0, updated_at = datetime('now')`)
      .run(name, kind, name, JSON.stringify(titles))
  }

  /** Templates whose pattern shares most words with `text`, best first; flagged ones are left out. */
  match(kind: TemplateKind, text: string, limit: number): PlanTemplate[] {
    return this.list()
      .filter((t) => t.kind === kind && !t.flagged)
      .map((t) => ({ t, score: overlap(text, t.pattern) }))
      .filter(({ score }) => score >= 0.5)
      .sort((a, b) => b.score - a.score || b.t.successes - a.t.successes)
      .slice(0, limit)
      .map(({ t }) => t)
  }

  recordUse(kind: TemplateKind, name: string): void {
    this.#db.prepare(`UPDATE plan_templates SET uses = uses + 1 WHERE kind = ? AND name = ?`).run(kind, name)
  }

  recordFailure(kind: TemplateKind, name: string): void {
    this.#db.prepare(`UPDATE plan_templates SET failures = failures + 1 WHERE kind = ? AND name = ?`).run(kind, name)
  }

  /** Flags templates that keep failing; returns their names. */
  flagFailing(): string[] {
    const rows = this.#db
      .prepare(`UPDATE plan_templates SET flagged = 1 WHERE flagged = 0 AND failures >= 2 AND failures > successes RETURNING name`)
      .all() as { name: string }[]
    return rows.map((r) => r.name)
  }

  delete(kind: TemplateKind, name: string): boolean {
    return Number(this.#db.prepare('DELETE FROM plan_templates WHERE kind = ? AND name = ?').run(kind, name).changes) > 0
  }
}
