import { z } from 'zod'
import type { GoalRow } from './db/goals.ts'
import type { Day, DayKind, Repos } from './db/repos.ts'
import { describeStructure } from './db/structures.ts'
import { errorMessage, truncate } from './lib/text.ts'
import { LLMFormatError, type LLMProvider } from './llm/types.ts'
import type { ToolSpec } from './tools/types.ts'

export const MAX_LESSONS = 12
const MAX_LESSON_CHARS = 200
const MAX_MEMORY_SETS = 20
const MAX_REVIEW = 10
const HISTORY_ENTRY_CHARS = 200
const HISTORY_ENTRIES = 150

/** A day (or nap) ends when today's history passes this many entries. */
export const NAP_AFTER_ENTRIES = 150
/** …or when the prompt grows past this many characters (and the day has some history to fold away). */
export const PROMPT_BUDGET_CHARS = 14_000
const NAP_MIN_ENTRIES = 30
/** A night with fewer history entries than this is not worth a reflection. */
const MIN_DAY_ENTRIES = 5

// Minecraft day ticks.
export const DUSK = 12_000
export const NIGHT = 13_000
const BED_FROM = 12_542
const BED_UNTIL = 23_459
const MORNING = 23_000

/** What write_journal asks for (also its JSON schema). */
const journalSpec = z.object({
  journal: z.string().describe('3-5 sentences: what happened today and what got done'),
  lessons: z.array(z.string()).describe(`the FULL new list of lessons (old ones merged with today's), at most ${MAX_LESSONS}, one short rule each`),
  memory: z
    .object({
      set: z.record(z.string(), z.string()).describe('facts to add or update, key → value'),
      delete: z.array(z.string()).describe('keys of facts that are wrong or no longer useful'),
    })
    .describe('changes to your memory'),
  goals: z
    .array(z.object({ id: z.number().int(), status: z.enum(['done', 'failed', 'dropped']), note: z.string().optional() }))
    .describe('goal tree nodes (ids in brackets) whose status should change'),
  skills_to_review: z.array(z.string()).describe('names of skills that failed and need fixing'),
})

/** A string, or a number sent as one; never coerces undefined into "undefined". */
const text = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())

/**
 * Small models sometimes echo the JSON schema around their answer, e.g. `{ "type": "array", "items": [...] }`
 * or `{ "type": "object", "properties": {...} }`. Unwrap that, recursively.
 */
export function unwrapSchemaEcho(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapSchemaEcho)
  if (typeof value !== 'object' || value === null) return value
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj.items) && (obj.type === 'array' || Object.keys(obj).every((k) => k === 'items' || k === 'type'))) {
    return unwrapSchemaEcho(obj.items)
  }
  if (obj.type === 'object' && typeof obj.properties === 'object' && obj.properties !== null) return unwrapSchemaEcho(obj.properties)
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, unwrapSchemaEcho(v)]))
}

const memoryInput = z.preprocess(
  (value) => {
    // Accept { set: [{ key, value }] } as well as { set: { key: value } }.
    if (typeof value !== 'object' || value === null) return value
    const { set, ...rest } = value as { set?: unknown }
    if (!Array.isArray(set)) return value
    return { ...rest, set: Object.fromEntries(set.map((e: { key?: unknown; value?: unknown }) => [String(e?.key), String(e?.value)])) }
  },
  z.object({ set: z.record(z.string(), text).default({}), delete: z.array(text).default([]) }),
)
const goalChange = z.object({ id: z.coerce.number().int(), status: z.enum(['done', 'failed', 'dropped']), note: z.string().optional() })
/** Items with another status ("active", "todo": no change) are skipped one by one rather than failing the list. */
const goalsInput = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const change = goalChange.safeParse(item)
    return change.success ? [change.data] : []
  }),
)

export interface JournalInput {
  journal: string
  /** Undefined when missing or unreadable: the old lessons stay. */
  lessons?: string[]
  memory: { set: Record<string, string>; delete: string[] }
  goals: z.output<typeof goalsInput>
  skills_to_review: string[]
}

/**
 * Lenient parsing: each field is read on its own, so one malformed field (dropped, with a note) does not throw
 * away the rest of the reflection. Only a missing journal makes the whole answer invalid.
 */
export function parseJournal(raw: unknown): { input: JournalInput; problems: string[] } | { error: string } {
  const args = unwrapSchemaEcho(raw) as Record<string, unknown>
  const journal = text.pipe(z.string().min(1)).safeParse(args?.journal)
  if (!journal.success) return { error: 'the journal text is missing' }
  const problems: string[] = []
  const field = <S extends z.ZodType>(name: string, schema: S, fallback: z.output<S>): z.output<S> => {
    const value = args[name]
    if (value === undefined) return fallback
    const result = schema.safeParse(value)
    if (result.success) return result.data
    // Also seen from qwen3:8b: the value wrapped in an object under one key, e.g. "goals": { "goals": [...] }.
    const keys = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []
    if (keys.length === 1) {
      const inner = schema.safeParse((value as Record<string, unknown>)[keys[0]!])
      if (inner.success) return inner.data
    }
    problems.push(`ignored unreadable ${name}`)
    return fallback
  }
  return {
    input: {
      journal: journal.data,
      lessons: field('lessons', z.array(text).optional(), undefined),
      memory: field('memory', memoryInput, { set: {}, delete: [] }),
      goals: field('goals', goalsInput, []),
      skills_to_review: field('skills_to_review', z.array(text), []),
    },
    problems,
  }
}

export function writeJournalSpec(): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(journalSpec) as Record<string, unknown>
  return { name: 'write_journal', description: 'Write down the day: journal, lessons, memory changes, goal updates.', parameters }
}

export function reflectionPrompt(name: string): string {
  return `You are the reflecting mind of ${name}, a Minecraft survival bot, at the end of its day. You do not act in the world now.
Read today's history and call write_journal exactly once:
- journal: 3-5 plain sentences about what happened and what got done.
- lessons: short, general rules learned from successes and failures (e.g. "oak_log needs no tool; stone needs a wooden_pickaxe"). Return the FULL list: keep good old lessons, merge duplicates, drop wrong ones. At most ${MAX_LESSONS}.
- memory: add facts worth keeping (places, resources) and delete facts that are outdated or wrong. Keep keys short.
- goals: mark goal tree nodes done, failed or dropped only if the history shows it.
- skills_to_review: skills that failed today.
Only call something built if it is listed under "Structures that really stand"; a few placed blocks are not a shelter.
Revelations are from the bot's creator: never contradict them.`
}

/** The day as the reflection reads it. */
export function reflectionInput(repos: Repos): string {
  const history = repos.history.recent(HISTORY_ENTRIES, repos.days.todayAfter())
  const memory = repos.memory.list()
  const lessons = repos.lessons.list()
  const skills = repos.skills.list()
  const revelations = repos.revelations.list()
  const goal = repos.goals.active()
  const tree: string[] = []
  if (goal) {
    tree.push(node(goal, 0))
    for (const sub of repos.goals.children(goal.id)) {
      tree.push(node(sub, 1))
      if (sub.status === 'active') for (const step of repos.goals.children(sub.id)) tree.push(node(step, 2))
    }
  }
  const list = (items: string[]): string => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '(none)')
  return [
    `## Today's history (oldest first)\n${list(history.map((h) => `[${h.kind}] ${truncate(h.content, HISTORY_ENTRY_CHARS)}`))}`,
    `## Memory (📌 = pinned by the player, kept anyway)\n${list(memory.map((m) => `${m.pinned ? '📌 ' : ''}${m.key}: ${m.value}`))}`,
    `## Lessons so far\n${list(lessons.map((l) => l.content))}`,
    `## Goal tree\n${tree.length > 0 ? tree.join('\n') : '(no goal)'}`,
    `## Structures that really stand (from the build tool; only these count as built)\n${list(repos.structures.list().map(describeStructure))}`,
    `## Skills\n${list(skills.map((s) => `${s.name}: ${s.successes} ok, ${s.failures} failed`))}`,
    `## Revelations (from your creator, read-only)\n${list(revelations.map((r) => r.content))}`,
    'Call write_journal now.',
  ].join('\n\n')
}

const node = (row: GoalRow, depth: number): string => `${'  '.repeat(depth)}[${row.id}] ${row.kind}: ${row.title} (${row.status})`

/** Applies a reflection, enforcing caps; returns notes on what was ignored. */
export function applyJournal(repos: Repos, input: JournalInput): string[] {
  const ignored: string[] = []
  repos.transaction(() => {
    if (input.lessons) {
      const lessons = [...new Set(input.lessons.filter(Boolean).map((l) => truncate(l, MAX_LESSON_CHARS)))].slice(0, MAX_LESSONS)
      repos.lessons.replaceLearned(lessons)
    }
    for (const key of input.memory.delete) {
      if (repos.memory.isPinned(key)) ignored.push(`kept pinned ${key}`)
      else repos.memory.delete(key)
    }
    for (const [key, value] of Object.entries(input.memory.set).slice(0, MAX_MEMORY_SETS)) {
      if (!key.trim() || !value) continue
      if (repos.memory.isPinned(key)) ignored.push(`kept pinned ${key}`)
      else repos.memory.set(truncate(key.trim(), 40), truncate(value, 200))
    }
    for (const change of input.goals) {
      if (!repos.goals.get(change.id)) {
        ignored.push(`unknown goal ${change.id}`)
        continue
      }
      repos.goals.update(change.id, { status: change.status, ...(change.note && { note: truncate(change.note, 300) }) })
    }
  })
  return ignored
}

export interface ConsolidateOptions {
  repos: Repos
  provider: LLMProvider
  /** The bot's name, for the reflection prompt. */
  name: string
  log: (line: string) => void
}

/**
 * Ends the day: one reflection call (retried once) writes the journal, lessons, memory and goal changes, and a new day
 * starts with an empty prompt history. If reflection fails, the day still ends.
 */
export async function consolidate({ repos, provider, name, log }: ConsolidateOptions, kind: DayKind): Promise<Day> {
  const after = repos.days.todayAfter()
  const until = repos.history.lastId()
  const startedAt = repos.history.firstTimeSince(after) ?? new Date().toISOString().slice(0, 19).replace('T', ' ')
  const spec = writeJournalSpec()
  let result: JournalInput | null = null
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      const decision = await provider.decide({ system: reflectionPrompt(name), user: reflectionInput(repos), tools: [spec] })
      if (decision.tool !== 'write_journal') throw new LLMFormatError(`called ${decision.tool} instead of write_journal`)
      const parsed = parseJournal(decision.args)
      if ('error' in parsed) throw new LLMFormatError(`invalid journal: ${parsed.error}`)
      if (parsed.problems.length > 0) log(`reflection: ${parsed.problems.join('; ')}`)
      result = parsed.input
    } catch (err) {
      log(`⚠ reflection attempt ${attempt} failed: ${errorMessage(err)}`)
    }
  }

  let journal = 'Slept without reflecting.'
  let review: string[] = []
  if (result) {
    const ignored = applyJournal(repos, result)
    if (ignored.length > 0) log(`reflection: ${ignored.join('; ')}`)
    journal = truncate(result.journal, 1_000)
    const skills = new Set(repos.skills.list().map((s) => s.name))
    review = [...new Set(result.skills_to_review)].filter((s) => skills.has(s)).slice(0, MAX_REVIEW)
  }
  const flagged = repos.templates.flagFailing()
  if (flagged.length > 0) log(`plan templates flagged as failing: ${flagged.join(', ')}`)
  return repos.days.add({ kind, startedAt, journal, historyUntil: until, skillsReview: review })
}

/** The parts of a mineflayer bot the scheduler uses. */
export interface SleepyBot {
  time: { timeOfDay: number; day: number }
  isSleeping: boolean
  wake(): Promise<void>
  on(event: 'sleep', listener: () => void): unknown
  removeListener(event: 'sleep', listener: () => void): unknown
}

/** The parts of the agent the scheduler uses. */
export interface PausableAgent {
  pause(): void
  resume(): void
  readonly promptChars: number
}

export type SleepEvent = { type: 'start'; kind: DayKind } | { type: 'end'; kind: DayKind; day: Day }

export interface SleepOptions extends ConsolidateOptions {
  bot: SleepyBot
  agent: PausableAgent
  onEvent?: (event: SleepEvent) => void
  intervalMs?: number
}

/** Decides when the bot sleeps or naps, and runs the consolidation while the agent loop is paused. */
export class SleepScheduler {
  readonly #options: SleepOptions
  #announced = -1
  #slept = -1
  #busy: Promise<Day> | null = null

  constructor(options: SleepOptions) {
    this.#options = options
    // Restarted at night shortly after a sleep: don't sleep twice.
    const latest = options.repos.days.latest()
    if (latest?.kind === 'sleep' && options.bot.time.timeOfDay >= NIGHT && Date.now() - Date.parse(`${latest.ended_at.replace(' ', 'T')}Z`) < 20 * 60_000) {
      this.#slept = options.bot.time.day
    }
  }

  get busy(): boolean {
    return this.#busy !== null
  }

  /** Starts watching the clock; returns a stop function. */
  start(): () => void {
    const { bot } = this.#options
    const onSleep = (): void => {
      if (this.#slept !== bot.time.day) this.#background('sleep')
    }
    bot.on('sleep', onSleep)
    const timer = setInterval(() => this.tick(), this.#options.intervalMs ?? 2_000)
    return () => {
      clearInterval(timer)
      bot.removeListener('sleep', onSleep)
    }
  }

  tick(): void {
    if (this.#busy) return
    const { bot, repos, agent } = this.#options
    const t = bot.time.timeOfDay
    const day = bot.time.day
    const night = t >= DUSK && t < MORNING
    if (night && this.#announced !== day) {
      this.#announced = day
      if (this.#slept !== day) {
        repos.history.add('event', 'night is falling: sleep in a bed (sleep tool; craft or place one if you have to). You will reflect on the day either way.')
      }
    }
    const entries = repos.history.countSince(repos.days.todayAfter())
    if (t >= NIGHT && t < MORNING && this.#slept !== day) {
      // Nothing to reflect on (e.g. connected at night): skip tonight instead of spending a model call.
      if (entries < MIN_DAY_ENTRIES) this.#slept = day
      else this.#background('sleep')
      return
    }
    if (entries > NAP_AFTER_ENTRIES || (agent.promptChars > PROMPT_BUDGET_CHARS && entries >= NAP_MIN_ENTRIES)) this.#background('nap')
  }

  #background(kind: DayKind): void {
    this.run(kind).catch((err: unknown) => this.#options.log(`⚠ ${kind} failed: ${errorMessage(err)}`))
  }

  /** Pause the agent, consolidate, wake up if it is still night, resume. Reflexes keep running throughout. */
  run(kind: DayKind): Promise<Day> {
    if (this.#busy) return this.#busy
    const { bot, agent, repos, log, onEvent } = this.#options
    if (kind === 'sleep') this.#slept = bot.time.day
    agent.pause()
    onEvent?.({ type: 'start', kind })
    log(kind === 'sleep' ? '😴 sleeping: reflecting on the day' : '😴 taking a nap: reflecting on the day so far')
    this.#busy = (async () => {
      try {
        const day = await consolidate(this.#options, kind)
        log(`📓 ${day.journal}`)
        repos.history.add('event', kind === 'sleep' ? 'you slept and reflected on the day; a new day begins' : 'you paused to reflect on the day so far')
        const t = bot.time.timeOfDay
        if (bot.isSleeping && t >= BED_FROM && t <= BED_UNTIL) {
          await bot.wake().catch(() => {})
          repos.history.add('event', 'it is still night: stay near your bed or shelter until morning')
        }
        onEvent?.({ type: 'end', kind, day })
        return day
      } finally {
        this.#busy = null
        agent.resume()
      }
    })()
    return this.#busy
  }
}
