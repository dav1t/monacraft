import { z } from 'zod'
import { describeStructure } from '../db/structures.ts'
import { truncate } from '../lib/text.ts'
import { words } from '../lib/words.ts'
import { defineTool, ToolError } from './types.ts'

/** History entries looked at per search (newest first). */
const HISTORY_CANDIDATES = 300
const LINE_CHARS = 220

/** Earlier sources win ties: what was built and remembered is more reliable than an old action. */
const SOURCES = ['built', 'memory', 'lesson', 'journal', 'history'] as const

export const recall = defineTool({
  name: 'recall',
  description:
    'Look up what you did, built or learned before — older history, past journals, memory, lessons and structures — by keywords, e.g. "furnace", "iron ore", "shelter".',
  schema: z.object({ query: z.string().trim().min(2).max(100), limit: z.number().int().min(1).max(12).default(8) }),
  run: async ({ query, limit }, { repos }) => {
    const terms = [...words(query)]
    if (terms.length === 0) throw new ToolError('give a few keywords to look for')
    const score = (text: string): number => {
      const lower = text.toLowerCase()
      return terms.filter((t) => lower.includes(t)).length
    }
    const found: { source: (typeof SOURCES)[number]; text: string; order: number }[] = []
    const add = (source: (typeof SOURCES)[number], text: string): void => {
      if (score(text) > 0) found.push({ source, text, order: found.length })
    }
    for (const s of repos.structures.list()) add('built', describeStructure(s))
    for (const m of repos.memory.list()) add('memory', `${m.key}: ${m.value}`)
    for (const l of repos.lessons.list()) add('lesson', l.content)
    for (const d of repos.days.list(60)) add('journal', `${d.ended_at.slice(0, 10)}: ${d.journal}`)
    for (const h of repos.history.search(terms, HISTORY_CANDIDATES)) add('history', `${h.created_at.slice(5, 16)} ${h.content}`)
    if (found.length === 0) return `nothing found about "${query}"`
    found.sort((a, b) => score(b.text) - score(a.text) || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.order - b.order)
    return found
      .slice(0, limit)
      .map((f) => `[${f.source}] ${truncate(f.text, LINE_CHARS)}`)
      .join('\n')
  },
})
