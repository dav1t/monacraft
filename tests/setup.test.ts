import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

describe('toolchain', () => {
  it('has node:sqlite', () => {
    const db = new DatabaseSync(':memory:')
    expect(db.prepare('SELECT 1 + 1 AS two').get()).toEqual({ two: 2 })
  })
})
