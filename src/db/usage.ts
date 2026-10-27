import type { DatabaseSync } from 'node:sqlite'
import type { CallRecord } from '../llm/providers.ts'

/** How one model did. Reflection calls count toward tokens and cost only. */
export interface ModelStats {
  provider: string
  model: string
  decisions: number
  /** Decisions that threw (unusable reply, network, bad key or model) or whose tool call returned an error. */
  failed: number
  inputTokens: number
  outputTokens: number
  /** USD; null when no call of this model reported a cost. */
  cost: number | null
  avgSeconds: number | null
}

/** Every model call, so models can be compared within a session (one bot join) and over all time. */
export class UsageRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** Returns the row id. */
  record(session: number, call: CallRecord): number {
    const { inputTokens, outputTokens, cost } = call.usage
    const result = this.#db
      .prepare(
        `INSERT INTO llm_calls (session, provider, model, kind, input_tokens, output_tokens, cost, duration_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(session, call.provider, call.model, call.kind, inputTokens ?? null, outputTokens ?? null, cost ?? null, call.durationMs, call.error ?? null)
    return Number(result.lastInsertRowid)
  }

  /** The decision's tool call returned an error. */
  markToolError(id: number): void {
    this.#db.prepare('UPDATE llm_calls SET tool_error = 1 WHERE id = ?').run(id)
  }

  /** Per model, most used first; all time when no session is given. */
  stats(session?: number): ModelStats[] {
    return this.#db
      .prepare(
        `SELECT provider, model,
           SUM(kind = 'decision') AS decisions,
           SUM(kind = 'decision' AND (error IS NOT NULL OR tool_error = 1)) AS failed,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           SUM(cost) AS cost,
           AVG(CASE WHEN kind = 'decision' THEN duration_ms END) / 1000.0 AS avgSeconds
         FROM llm_calls
         WHERE ? IS NULL OR session = ?
         GROUP BY provider, model
         ORDER BY decisions DESC, provider, model`,
      )
      .all(session ?? null, session ?? null) as unknown as ModelStats[]
  }

  /** What this session's calls cost; null when none reported a cost. */
  sessionCost(session: number): number | null {
    const row = this.#db.prepare('SELECT SUM(cost) AS cost FROM llm_calls WHERE session = ?').get(session) as { cost: number | null }
    return row.cost
  }
}
