import type { DatabaseSync } from 'node:sqlite'

/** What wrote an identity version: the birth, a reflection (sleep, nap or death) or the player in the panel. */
export type IdentityReason = 'birth' | 'sleep' | 'nap' | 'death' | 'player'

export interface Identity {
  id: number
  /** Who the bot is, in its own words (first person). */
  self: string
  /** What it wants now. */
  wants: string
  reason: IdentityReason
  /** The chance words it was born with (birth only). */
  seeds: string | null
  created_at: string
}

/** The bot's self-description. Every change adds a version, so the panel can show how it grew. */
export class IdentityRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  current(): Identity | undefined {
    return this.#db.prepare('SELECT * FROM identity ORDER BY id DESC LIMIT 1').get() as unknown as Identity | undefined
  }

  /** Newest first. */
  list(limit: number): Identity[] {
    return this.#db.prepare('SELECT * FROM identity ORDER BY id DESC LIMIT ?').all(limit) as unknown as Identity[]
  }

  /** Adds a version unless nothing changed; returns whether one was added. */
  update(next: { self: string; wants: string; reason: IdentityReason; seeds?: string }): boolean {
    const current = this.current()
    if (current && current.self === next.self && current.wants === next.wants) return false
    this.#db
      .prepare('INSERT INTO identity (self, wants, reason, seeds) VALUES (?, ?, ?, ?)')
      .run(next.self, next.wants, next.reason, next.seeds ?? null)
    return true
  }
}

export interface Scar {
  id: number
  cause: string
  place: string
  /** What it carried when it died. */
  lost: string
  /** What the death meant to the bot, written when it reflected on it; null until then (or if it had no time). */
  meaning: string | null
  created_at: string
}

/** The bot's deaths, kept as moments of its life. */
export class ScarRepo {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  add(scar: { cause: string; place: string; lost: string }): Scar {
    return this.#db
      .prepare('INSERT INTO scars (cause, place, lost) VALUES (?, ?, ?) RETURNING *')
      .get(scar.cause, scar.place, scar.lost) as unknown as Scar
  }

  /** Newest first. */
  list(): Scar[] {
    return this.#db.prepare('SELECT * FROM scars ORDER BY id DESC').all() as unknown as Scar[]
  }

  /** The latest death, if the bot has not reflected on it yet. */
  unreflected(): Scar | undefined {
    const latest = this.#db.prepare('SELECT * FROM scars ORDER BY id DESC LIMIT 1').get() as unknown as Scar | undefined
    return latest?.meaning === null ? latest : undefined
  }

  setMeaning(id: number, meaning: string): boolean {
    return Number(this.#db.prepare('UPDATE scars SET meaning = ? WHERE id = ?').run(meaning, id).changes) > 0
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM scars WHERE id = ?').run(id).changes) > 0
  }
}

/** One line for prompts and recall. */
export function describeScar(scar: Pick<Scar, 'cause' | 'place' | 'meaning'>): string {
  return `${scar.cause} at ${scar.place}${scar.meaning ? ` — ${scar.meaning}` : ''}`
}
