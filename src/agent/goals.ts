import type { GoalRow, GoalStatus } from '../db/goals.ts'
import type { Repos } from '../db/repos.ts'
import { truncate } from '../lib/text.ts'
import { normalizeTitle, words } from '../lib/words.ts'
import type { McData } from '../planning/data.ts'
import { describeStep, planItem } from '../planning/planner.ts'
import type { PlanningWorld } from '../planning/world.ts'

export const MAX_SUBGOALS = 8
export const MAX_STEPS = 10
/** Goals kept paused at once; older ones are dropped. */
const MAX_PAUSED = 5
/** A step that fails this many times in a row gets a warning in the history. */
const FAILS_BEFORE_WARNING = 2

/** Tools that don't act in the world, so they neither finish nor fail a step. */
const META_TOOLS = new Set([
  'say', 'wait', 'remember', 'forget', 'set_goal', 'plan_goal', 'switch_subgoal', 'set_steps', 'done', 'give_up', 'plan_item',
  'create_skill', 'revise_skill', 'scan_blocks', 'find_blocks', 'find_entities', 'look_at', 'recall',
])

export interface SubgoalNode extends GoalRow {
  steps: GoalRow[]
}

export interface GoalTree {
  goal: GoalRow
  subgoals: SubgoalNode[]
}

const ITEM_GOAL = /^(?:(?:get|craft|make|obtain|collect|gather|smelt)\s+)?(?:(?:a|an|some)\s+)?(?:(\d+)\s+)?([a-z][a-z0-9_ ]*?)(?:\s*x\s*(\d+)|\s+(\d+))?$/

/** "craft a stone pickaxe", "get 24 iron_ingot", "iron_ingot x24" → the item and count; null for other goals. */
export function parseItemGoal(data: McData, text: string): { item: string; count: number } | null {
  const match = ITEM_GOAL.exec(text.trim().toLowerCase().replace(/[.!]+$/, ''))
  if (!match) return null
  const name = match[2]!.trim().replace(/\s+/g, '_')
  const count = Number(match[1] ?? match[3] ?? match[4] ?? 1)
  for (const candidate of [name, name.replace(/s$/, ''), name.replace(/es$/, '')]) {
    if (data.itemsByName[candidate]) return { item: candidate, count: Math.max(1, Math.min(count, 64 * 36)) }
  }
  return null
}

const titleFor = (item: string, count: number): string => (count > 1 ? `get ${item} x${count}` : `get ${item}`)

const ICONS: Record<GoalStatus, string> = { todo: '☐', active: '▶', done: '✓', failed: '✗', dropped: '–', paused: '⏸' }

/**
 * The goal tree and its bookkeeping. All state lives in the database, so a keeper can be created wherever it is needed
 * (the agent, a tool, the panel). Without a world (offline), nothing is planned or checked against the inventory.
 */
export class GoalKeeper {
  readonly #repos: Repos
  readonly #world: PlanningWorld | null

  constructor(repos: Repos, world: PlanningWorld | null = null) {
    this.#repos = repos
    this.#world = world
  }

  tree(): GoalTree | null {
    const goal = this.#repos.goals.active()
    if (!goal) return null
    return { goal, subgoals: this.#repos.goals.children(goal.id).map((s) => ({ ...s, steps: this.#repos.goals.children(s.id) })) }
  }

  /**
   * Makes `title` the active goal. The current goal is paused, not lost; a paused goal with the same title is resumed
   * with its plan. Crafting goals get their sub-goals from the planner; `template` reuses a saved plan.
   */
  setGoal(title: string, template?: string): string {
    const current = this.#repos.goals.active()
    if (current && sameTitle(current.title, title)) return `already working on: ${current.title}`
    const resumed = this.#repos.goals.paused().find((g) => sameTitle(g.title, title))
    // Small models fill optional arguments with made-up names: an unknown template must not cost the goal.
    const saved = template && !resumed ? (this.#repos.templates.get('goal', template) ?? this.#repos.templates.match('goal', template, 1)[0]) : undefined
    const goal = this.#repos.transaction(() => {
      if (current) this.#repos.goals.update(current.id, { status: 'paused' })
      for (const old of this.#repos.goals.paused().filter((g) => g.id !== resumed?.id).slice(MAX_PAUSED)) {
        this.#repos.goals.update(old.id, { status: 'dropped' })
      }
      if (resumed) {
        this.#repos.goals.update(resumed.id, { status: 'active' })
        return resumed
      }
      const row = this.#repos.goals.create({ parentId: null, kind: 'goal', title, status: 'active', template: saved?.name ?? null })
      if (saved) {
        this.#repos.templates.recordUse('goal', saved.name)
        this.#addChildren(row.id, 'subgoal', saved.titles.slice(0, MAX_SUBGOALS))
      }
      return row
    })
    this.refresh()
    const ignored = template && !saved && !resumed ? ` (no plan template named "${template}", so none was used)` : ''
    const paused = current ? ` (paused: ${current.title} — set_goal with its title resumes it)` : ''
    if (this.#repos.goals.get(goal.id)?.status === 'done') return `goal "${goal.title}" is already reached${paused}`
    return resumed ? `goal resumed: ${goal.title}${paused}` : `goal set: ${title}${ignored}${paused}`
  }

  /** Works on another open (or failed) sub-goal now; the current one stays open for later. */
  switchSubgoal(title: string): string {
    const goal = this.#requireGoal()
    const open = this.#repos.goals.children(goal.id).filter((s) => s.status === 'todo' || s.status === 'failed')
    const wanted = normalizeTitle(title)
    const target = open.find((s) => sameTitle(s.title, title)) ?? open.find((s) => normalizeTitle(s.title).includes(wanted))
    if (!target) throw new Error(`no open sub-goal "${title}"; open: ${open.map((s) => s.title).join('; ') || '(none)'}`)
    const current = this.#activeSub(goal.id)
    this.#repos.transaction(() => {
      if (current) this.#repos.goals.update(current.id, { status: 'todo' })
      this.#repos.goals.update(target.id, { status: 'active', attempts: 0 })
    })
    this.refresh()
    return `now working on: ${target.title}${current ? ` (${current.title} stays open)` : ''}`
  }

  /** Sets the sub-goals of the active goal. Finished ones are kept; the rest are replaced. */
  planGoal(titles: string[]): string {
    const goal = this.#requireGoal()
    const { accepted, note } = this.#checkTitles(goal.id, titles, 'sub-goal')
    this.#repos.goals.deleteChildren(goal.id, ['todo', 'active', 'failed', 'dropped'])
    this.#addChildren(goal.id, 'subgoal', accepted.slice(0, MAX_SUBGOALS))
    this.refresh()
    return `sub-goals set${note}`
  }

  /** Sets the steps of the active sub-goal (creating one named like the goal if there is none). */
  setSteps(titles: string[]): string {
    const goal = this.#requireGoal()
    let sub = this.#activeSub(goal.id)
    if (!sub && this.#repos.goals.children(goal.id).some((s) => s.status === 'todo')) throw new Error('no active sub-goal')
    // Check against the goal (and the sub-goal, if there is one) before creating anything.
    const { accepted, note } = this.#checkTitles(sub?.id ?? goal.id, titles, 'step')
    // Steps for a goal without sub-goals go into one sub-goal standing for the whole goal.
    sub ??= this.#repos.goals.create({ parentId: goal.id, kind: 'subgoal', title: goal.title, status: 'active' })
    this.#repos.goals.deleteChildren(sub.id, ['todo', 'active', 'failed', 'dropped'])
    this.#addChildren(sub.id, 'step', accepted.slice(0, MAX_STEPS))
    this.refresh()
    return `steps set for "${sub.title}"${note}`
  }

  /** Marks the active step done (or the sub-goal, or the goal, when there is nothing below) and moves on. */
  done(note?: string): string {
    const goal = this.#requireGoal()
    const sub = this.#activeSub(goal.id)
    if (!sub) {
      if (this.#repos.goals.children(goal.id).some((s) => s.status === 'todo' || s.status === 'failed')) {
        throw new Error('no active sub-goal; replan the failed one with plan_goal')
      }
      this.#requireBuilt(goal)
      this.#completeGoal(goal, note)
      return `goal reached: ${goal.title}`
    }
    const step = this.#repos.goals.children(sub.id).find((s) => s.status === 'active')
    this.#requireBuilt(step ?? sub)
    const what = step ? `step done: ${step.title}` : `sub-goal done: ${sub.title}`
    if (step) this.#completeStep(sub, step, note)
    else this.#completeSub(sub, note)
    this.refresh()
    return what
  }

  /** Marks the active sub-goal failed; the model must replan it. */
  giveUp(reason: string): string {
    const goal = this.#requireGoal()
    const sub = this.#activeSub(goal.id)
    if (!sub) {
      this.#repos.goals.update(goal.id, { status: 'failed', note: reason })
      if (goal.template) this.#repos.templates.recordFailure('goal', goal.template)
      this.#event(`goal failed: ${goal.title} (${reason})`)
      return 'goal given up; choose a new one with set_goal'
    }
    this.#repos.goals.update(sub.id, { status: 'failed', note: reason })
    for (const step of this.#repos.goals.children(sub.id)) {
      if (step.status === 'todo' || step.status === 'active') this.#repos.goals.update(step.id, { status: 'dropped' })
    }
    return `sub-goal failed: ${sub.title}. Replan with plan_goal (finished sub-goals are kept).`
  }

  /** Panel edits: rename, or set a status (done goes through the normal completion so plans advance). */
  edit(id: number, changes: { title?: string; status?: GoalStatus }): boolean {
    const row = this.#repos.goals.get(id)
    if (!row) return false
    if (changes.title) this.#repos.goals.update(id, { title: changes.title })
    if (changes.status && changes.status !== row.status) {
      if (changes.status === 'done' && row.kind === 'goal') this.#completeGoal(row)
      else if (changes.status === 'done' && row.kind === 'subgoal') this.#completeSub(row)
      else if (changes.status === 'done' && row.kind === 'step' && row.parent_id !== null) {
        const sub = this.#repos.goals.get(row.parent_id)
        if (sub) this.#completeStep(sub, row)
      } else this.#repos.goals.update(id, { status: changes.status })
    }
    this.refresh()
    return true
  }

  /** Panel: add a sub-goal to a goal, or a step to a sub-goal. */
  addChild(parentId: number, title: string): GoalRow {
    const parent = this.#repos.goals.get(parentId)
    if (!parent || parent.kind === 'step') throw new Error('can only add below a goal or a sub-goal')
    const kind = parent.kind === 'goal' ? 'subgoal' : 'step'
    this.#checkTitles(parentId, [title], kind === 'subgoal' ? 'sub-goal' : 'step')
    const twin = this.#repos.goals.children(parentId).find((c) => c.status !== 'dropped' && sameTitle(c.title, title))
    if (twin) throw new Error(`"${twin.title}" is already there — this repeats it`)
    const row =this.#repos.goals.create({ parentId, kind, title })
    this.refresh()
    return row
  }

  /**
   * Bookkeeping in code, run before every prompt: plan crafting goals and sub-goals, mark sub-goals done whose item is in
   * the inventory, and activate what comes next.
   */
  refresh(): void {
    for (let round = 0; round < 20; round++) {
      if (!this.#refreshOnce()) return
    }
  }

  /** One bookkeeping move; true when something changed and another round may be needed. */
  #refreshOnce(): boolean {
    const goal = this.#repos.goals.active()
    if (!goal) return false
    const target = this.#item(goal.title)
    if (target && this.#has(target)) {
      this.#completeGoal(goal)
      return false
    }
    const subs = this.#repos.goals.children(goal.id)
    if (subs.length === 0) return target ? this.#planSubgoals(goal, target) : false

    const sub = subs.find((s) => s.status === 'active')
    if (!sub) {
      const next = subs.find((s) => s.status === 'todo')
      if (next) {
        this.#repos.goals.update(next.id, { status: 'active', attempts: 0 })
        return true
      }
      if (!subs.some((s) => s.status === 'failed')) {
        this.#completeGoal(goal)
      }
      return false
    }

    const item = this.#item(sub.title)
    if (item && this.#has(item)) {
      this.#completeSub(sub)
      return true
    }
    const steps = this.#repos.goals.children(sub.id)
    if (steps.some((s) => s.status === 'active')) return false
    const nextStep = steps.find((s) => s.status === 'todo')
    if (nextStep) {
      this.#repos.goals.update(nextStep.id, { status: 'active', attempts: 0 })
      return true
    }
    if (item) {
      // All planned steps are done but the item is still missing (or there were none yet): plan again from here.
      this.#repos.goals.deleteChildren(sub.id, ['done', 'dropped', 'failed'])
      return this.#planSteps(sub, item)
    }
    if (steps.length > 0) {
      this.#completeSub(sub)
      return true
    }
    const template = this.#repos.templates.get('subgoal', sub.title)
    if (template && !template.flagged) {
      this.#repos.templates.recordUse('subgoal', template.name)
      this.#addChildren(sub.id, 'step', template.titles.slice(0, MAX_STEPS))
      return true
    }
    return false
  }

  /** After each action: tick off the step it finished, or count a failure. */
  afterAction(tool: string, args: Record<string, unknown>, outcome: string): void {
    if (META_TOOLS.has(tool)) return
    const goal = this.#repos.goals.active()
    const sub = goal && this.#activeSub(goal.id)
    if (!sub) return
    const step = this.#repos.goals.children(sub.id).find((s) => s.status === 'active')
    const target = step ?? sub
    if (outcome.startsWith('ok:')) {
      if (tool === 'build' && outcome.startsWith('ok: built') && isBuildTitle(target.title)) {
        // A finished build completes the building step (or sub-goal) it was for.
        if (step) this.#completeStep(sub, step)
        else this.#completeSub(sub)
      } else if (step) {
        const match = matchStep(step.title, tool, args, outcome)
        if (match === 'done') this.#completeStep(sub, step)
        else if (match) this.#repos.goals.update(step.id, { title: match, attempts: 0 })
        else if (target.attempts > 0) this.#repos.goals.update(target.id, { attempts: 0 })
      } else if (target.attempts > 0) this.#repos.goals.update(target.id, { attempts: 0 })
      this.refresh()
    } else if (outcome.startsWith('error:')) {
      const attempts = target.attempts + 1
      this.#repos.goals.update(target.id, { attempts })
      if (attempts % FAILS_BEFORE_WARNING === 0) {
        this.#event(
          step
            ? `step "${step.title}" failed ${attempts} times in a row — revise the sub-goal (give_up) or change the steps (set_steps)`
            : `sub-goal "${sub.title}" failed ${attempts} times in a row — give_up and replan it, or set_steps`,
        )
      }
    }
  }

  /** The words the bot is working on, for picking relevant skills. */
  focus(): string {
    const goal = this.#repos.goals.active()
    if (!goal) return ''
    return this.#activeSub(goal.id)?.title ?? goal.title
  }

  /** Whether the active goal still waits for a plan from the model (a non-crafting goal without sub-goals). */
  needsPlan(): boolean {
    const goal = this.#repos.goals.active()
    return !!goal && this.#repos.goals.children(goal.id).length === 0 && !this.#item(goal.title)
  }

  /** The goal tree as the model sees it: every sub-goal (the active one with its steps) and the paused goals. */
  section(): string | null {
    const tree = this.tree()
    if (!tree) return null
    const { goal, subgoals } = tree
    const index = subgoals.findIndex((s) => s.status === 'active')
    const head = `## Goal: ${goal.title}${index >= 0 ? ` (sub-goal ${index + 1}/${subgoals.length})` : ''}`
    const lines = [head]
    if (subgoals.length === 0) {
      lines.push(`(no plan yet — call plan_goal with 2-${MAX_SUBGOALS} sub-goals, or set_goal with an item name to get a plan)`)
    }
    for (const sub of subgoals) {
      if (sub.status === 'dropped') continue
      if (sub.status === 'failed') {
        lines.push(`✗ ${sub.title} — failed${sub.note ? `: ${truncate(sub.note, 120)}` : ''}`)
        continue
      }
      if (sub.status !== 'active') {
        lines.push(`${ICONS[sub.status]} ${sub.title}`)
        continue
      }
      lines.push(`▶ ${sub.title}${this.#progress(sub.title)}`)
      for (const step of sub.steps) {
        if (step.status === 'dropped') continue
        lines.push(`  ${ICONS[step.status]} ${step.title}`)
      }
      if (sub.steps.length === 0 && !this.#item(sub.title)) lines.push('  (no steps — set_steps, or just do it and call done)')
    }
    const paused = this.#repos.goals.paused()
    if (paused.length > 0) lines.push(`Paused goals (set_goal with the title resumes one): ${paused.map((g) => g.title).join('; ')}`)
    return lines.join('\n')
  }

  /** "last goal reached: X" and the paused goals, for an empty goal section. */
  lastGoalNote(): string | null {
    const last = this.#repos.goals.past(1)[0]
    const paused = this.#repos.goals.paused()
    const notes = [
      ...(last ? [`last goal ${last.status === 'done' ? 'reached' : last.status}: ${last.title}`] : []),
      ...(paused.length > 0 ? [`paused: ${paused.map((g) => g.title).join('; ')} (set_goal with the title resumes it)`] : []),
    ]
    return notes.length > 0 ? notes.join('; ') : null
  }

  #progress(title: string): string {
    const item = this.#item(title)
    if (!item || !this.#world) return ''
    return ` (have ${this.#world.inventory()[item.item] ?? 0}/${item.count})`
  }

  #planSubgoals(goal: GoalRow, target: { item: string; count: number }): boolean {
    const world = this.#world!
    let tools: string[]
    try {
      tools = planItem(world.data, target.item, target.count, world.inventory(), world.stations()).tools
    } catch {
      return false
    }
    const titles = [...tools.map((t) => titleFor(t, 1)), titleFor(target.item, target.count)].slice(-MAX_SUBGOALS)
    this.#addChildren(goal.id, 'subgoal', titles)
    return true
  }

  #planSteps(sub: GoalRow, target: { item: string; count: number }): boolean {
    const world = this.#world
    if (!world) return false
    try {
      const plan = planItem(world.data, target.item, target.count, world.inventory(), world.stations())
      this.#addChildren(sub.id, 'step', plan.steps.slice(0, MAX_STEPS).map(describeStep))
      return plan.steps.length > 0
    } catch {
      return false
    }
  }

  #completeStep(sub: GoalRow, step: GoalRow, note?: string): void {
    this.#repos.goals.update(step.id, { status: 'done', attempts: 0, ...(note && { note }) })
    const rest = this.#repos.goals.children(sub.id).filter((s) => s.status === 'todo' || s.status === 'active')
    if (rest.length > 0) return
    // The last step finished the sub-goal, unless it names an item that is still missing (refresh plans the rest).
    const item = this.#item(sub.title)
    if (!item || !this.#world) this.#completeSub(sub)
  }

  #completeSub(sub: GoalRow, note?: string): void {
    this.#repos.goals.update(sub.id, { status: 'done', attempts: 0, ...(note && { note }) })
    const steps = this.#repos.goals.children(sub.id)
    for (const step of steps) if (step.status === 'todo' || step.status === 'active') this.#repos.goals.update(step.id, { status: 'dropped' })
    const titles = steps.filter((s) => s.status === 'done').map((s) => s.title)
    if (!this.#item(sub.title) && titles.length > 0) this.#repos.templates.save('subgoal', sub.title, titles)
    this.#event(`sub-goal done: ${sub.title}`)
  }

  #completeGoal(goal: GoalRow, note?: string): void {
    this.#repos.goals.update(goal.id, { status: 'done', ...(note && { note }) })
    const subs = this.#repos.goals.children(goal.id)
    for (const sub of subs) if (sub.status === 'todo' || sub.status === 'active') this.#repos.goals.update(sub.id, { status: 'dropped' })
    const titles = subs.filter((s) => s.status === 'done').map((s) => s.title)
    // Crafting goals don't need templates: the planner does better.
    if (!this.#item(goal.title) && titles.length > 0) {
      this.#repos.templates.save('goal', goal.title, titles)
      if (goal.template && goal.template !== this.#repos.templates.get('goal', goal.title)?.name) this.#repos.templates.save('goal', goal.template, titles)
    }
    this.#event(`goal reached: ${goal.title} — choose the next one with set_goal`)
  }

  /**
   * A building goal is done when something stands, not when the model says so: it once called four stacked planks
   * "a basic shelter". Requires a structure completed since the node was created.
   */
  #requireBuilt(row: GoalRow): void {
    if (!isBuildTitle(row.title)) return
    const built = this.#repos.structures.list().some((s) => s.status === 'complete' && s.updated_at >= row.created_at)
    if (!built) {
      throw new Error(
        `nothing has been built for "${row.title}" yet — use build (e.g. build { shape: "shelter", block: "oak_planks" }); it is done when the build completes`,
      )
    }
  }

  /**
   * Keeps the tree from repeating itself: a sub-goal or step that restates something above it (or an earlier entry in
   * the same list) breaks nothing down, so it is left out. Throws when nothing is left.
   */
  #checkTitles(parentId: number, titles: string[], what: 'sub-goal' | 'step'): { accepted: string[]; note: string } {
    const above = this.#repos.goals.lineage(parentId)
    const accepted: string[] = []
    const repeats: string[] = []
    for (const title of titles.map((t) => t.trim()).filter(Boolean)) {
      const same = (other: string): boolean => sameTitle(title, other)
      if (above.some((row) => same(row.title)) || accepted.some(same)) repeats.push(title)
      else accepted.push(title)
    }
    if (accepted.length === 0) {
      const of = above[0] ? ` "${above[0].title}"` : ''
      throw new Error(`each ${what} repeats${of} or another entry — split it into smaller, concrete parts instead`)
    }
    const note = repeats.length > 0 ? ` (left out, they repeat what is above or each other: ${repeats.join('; ')})` : ''
    return { accepted, note }
  }

  #addChildren(parentId: number, kind: 'subgoal' | 'step', titles: string[]): void {
    for (const title of titles) {
      const clean = title.trim()
      if (clean) this.#repos.goals.create({ parentId, kind, title: truncate(clean, 200) })
    }
  }

  #activeSub(goalId: number): GoalRow | undefined {
    return this.#repos.goals.children(goalId).find((s) => s.status === 'active')
  }

  #requireGoal(): GoalRow {
    const goal = this.#repos.goals.active()
    if (!goal) throw new Error('no active goal; set one with set_goal')
    return goal
  }

  #item(title: string): { item: string; count: number } | null {
    return this.#world ? parseItemGoal(this.#world.data, title) : null
  }

  #has(target: { item: string; count: number }): boolean {
    return (this.#world?.inventory()[target.item] ?? 0) >= target.count
  }

  #event(text: string): void {
    this.#repos.history.add('event', text)
  }
}

const BUILD_TITLE =
  /^\s*(?:build|construct|put up|set up|make|create)\b.*\b(?:shelter|house|hut|home|walls?|roof|floor|pillar|tower|base|fence)\b|^\s*build\b/i

/** "build a basic shelter", "make a hut", "build walls" — but not "gather planks for the shelter". */
export function isBuildTitle(title: string): boolean {
  return BUILD_TITLE.test(title)
}

/** Same title up to case, punctuation, filler words and word order: "Build a shelter" = "build shelter". */
export function sameTitle(a: string, b: string): boolean {
  if (normalizeTitle(a) === normalizeTitle(b)) return true
  const wa = words(a)
  const wb = words(b)
  return wa.size > 0 && wa.size === wb.size && [...wa].every((w) => wb.has(w))
}

const STEP = /^(craft|mine|smelt|place)\s+([a-z0-9_]+)(?:\s+x(\d+))?(?:.*→\s*([a-z0-9_]+))?/

/**
 * Whether a successful action finished a step written like the planner writes them ("mine stone x3 … → cobblestone").
 * Returns 'done', a new title with the remaining count after a partial mine, or null.
 */
export function matchStep(title: string, tool: string, args: Record<string, unknown>, outcome: string): 'done' | string | null {
  const m = STEP.exec(title)
  if (!m) return null
  const [, verb, name, countText, drop] = m
  const count = countText ? Number(countText) : 1
  switch (verb) {
    case 'craft': {
      if (tool !== 'craft' || args.item !== name) return null
      const have = /now have (\d+)/.exec(outcome)
      return !countText || !have || Number(have[1]) >= count ? 'done' : null
    }
    case 'smelt':
      return tool === 'smelt' && args.item === name ? 'done' : null
    case 'place':
      return tool === 'place' && args.block_type === name ? 'done' : null
    case 'mine': {
      if (tool !== 'mine' || (args.block_type !== name && args.block_type !== drop)) return null
      const mined = Number(/mined (\d+)/.exec(outcome)?.[1] ?? count)
      if (mined >= count) return 'done'
      return title.replace(`x${count}`, `x${count - mined}`)
    }
  }
  return null
}
