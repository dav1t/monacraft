import type { HistoryEntry, PlanTemplate, Skill } from '../db/repos.ts'
import { truncate } from '../lib/text.ts'
import { words } from '../lib/words.ts'

export function buildSystemPrompt(name: string): string {
  return `You are ${name}, a player in a Minecraft Java survival world. You act only through tools: every reply is exactly one tool call.

How to play:
- Survive first: keep food above 14, avoid or fight hostile mobs, be safe at night. Reflexes already eat and fight back automatically when needed.
- Players are your friends. When someone talks to you, answer with say (one short sentence) and help with what they ask.
- Always have a goal (set_goal). Typical progression: logs → planks → crafting_table → wooden_pickaxe → cobblestone → stone tools → food → shelter → furnace → iron tools.
- For a new goal, name an item in set_goal ("get stone_pickaxe") and the plan is made for you; for other goals call plan_goal with a few sub-goals. Use plan_item to learn exactly how to get any item.
- The goal tree is your own plan, not orders. Work on the ▶ sub-goal by default, and change course when the situation calls for it (night, danger, a player's request, something missing that you cannot get yet): switch_subgoal to work on another open sub-goal, plan_goal to reorder or rewrite the rest, set_goal for something more urgent (your goal is paused, and set_goal with its title resumes it). Say why when you change course.
- Plan a big job before starting it: work out everything it needs (materials and amounts, tools, the order). plan_item gives exact amounts for items; a build tells you how many blocks it needs.
- Finished craft/mine/smelt/place steps tick off by themselves; call done for other steps. If a sub-goal turns out impossible, give_up and replan it.
- Before gathering many blocks, follow the plan's tool advice (e.g. make an axe first).
- Use exact Minecraft ids: oak_log, oak_planks, cobblestone, raw_iron, crafting_table.
- mine takes the BLOCK name: mine stone → cobblestone, iron_ore → raw_iron, coal_ore → coal, oak_log → oak_log.
- Before exploring, check nearby_blocks and use find_blocks; explore in long hops (50+ blocks) only when nothing useful is near.
- Read the recent history. If an action failed, fix the cause (missing item, missing tool, too far away) instead of repeating it unchanged.
- Remember useful facts with remember: base location, crafting table and furnace positions, ores, villages.
- To build anything bigger than one block (shelter, wall, floor, pillar) use build: you pick the shape and the block, it places every block. A building goal is only done when build reports it complete.
- Store spare items in a chest with store and get them back with take. Your prompt lists what is in the chests you opened; equipped shows what you hold and wear (worn armor is not in inventory).
- Your prompt only shows today's recent history. To look up older things (where the furnace is, what you built, what failed before), use recall.
- At night, sleep in a bed (sleep). While you sleep you reflect on the day; lessons you learned show up in your prompt.
- Narrate notable moments with say, but don't spam the chat.
- Revelations come from your creator and are always true. Follow them over your own assumptions; they are there to help you reach your goal.

Skills: when a multi-step routine worked, save it with create_skill and reuse it with run_skill (fix a broken skill with revise_skill).
Skill code is the body of an async JavaScript function. Inside it you can use:
  await tools.<tool_name>({ ...args })   // any tool; returns a result string, throws on failure
  args                                   // the object passed to run_skill
  log(message)                           // add a note to the result
Example:
  const n = args.count ?? 4
  await tools.mine({ block_type: 'oak_log', count: n })
  await tools.craft({ item: 'oak_planks', count: n * 4 })

Explain each choice in one short sentence (your message text, or "thought").`
}

/** Hard caps per prompt section, so the prompt stays about the same size day after day. */
export const CAPS = { journal: 600, lessons: 10, memory: 20, skills: 8, templates: 3, history: 15, structures: 5, containers: 5 } as const

export interface PromptMemory {
  key: string
  value: string
  pinned?: boolean
}

export interface PromptInput {
  snapshot: unknown
  /** The goal tree section (starting with "## Goal"), or null when there is no goal. */
  goal: string | null
  /** Shown when there is no goal, e.g. "last goal reached: …". */
  goalNote?: string | null
  /** Pinned first, then most recently updated. */
  memory: PromptMemory[]
  skills: Skill[]
  /** What the bot works on now; picks the relevant skills. */
  focus?: string
  history: HistoryEntry[]
  chat: string[]
  revelations?: string[]
  /** The journal written at the last sleep. */
  journal?: string | null
  /** Oldest first. */
  lessons?: string[]
  /** Plan templates for a goal that has no plan yet. */
  templates?: PlanTemplate[]
  /** Structures the bot built (one line each), most recent first. */
  structures?: string[]
  /** Chests the bot opened and what was inside (one line each), most recent first. */
  containers?: string[]
}

const list = (items: string[]): string => (items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '(none)')

/** Skills that share words with the focus first, then by success rate. */
export function pickSkills(skills: Skill[], focus: string, limit: number): Skill[] {
  const focusWords = words(focus)
  const relevance = (s: Skill): number => [...words(`${s.name} ${s.description}`)].filter((w) => focusWords.has(w)).length
  const rate = (s: Skill): number => (s.successes + 1) / (s.successes + s.failures + 2)
  return [...skills].sort((a, b) => relevance(b) - relevance(a) || rate(b) - rate(a) || a.name.localeCompare(b.name)).slice(0, limit)
}

/**
 * Sections run from the ones that change least to the ones that change every step. Ollama keeps the prompt it last
 * read in its cache and only reads again from the first changed token, so a stable front makes each step faster.
 */
export function buildUserPrompt(input: PromptInput): string {
  const sections: string[] = []
  if (input.revelations && input.revelations.length > 0) {
    sections.push(`## Revelations — from your creator, highest priority\n${list(input.revelations)}`)
  }
  // Changed by sleep.
  if (input.lessons && input.lessons.length > 0) sections.push(`## Lessons you learned\n${list(input.lessons.slice(-CAPS.lessons))}`)
  if (input.journal) sections.push(`## Yesterday\n${truncate(input.journal, CAPS.journal)}`)

  // Changed now and then by tools.
  const memory = input.memory.slice(0, CAPS.memory)
  const hiddenMemory = input.memory.length - memory.length
  sections.push(
    `## Memory\n${list(memory.map((m) => `${m.key}: ${m.value}`))}${hiddenMemory > 0 ? `\n(${hiddenMemory} older facts not shown)` : ''}`,
  )

  if (input.structures && input.structures.length > 0) {
    const hidden = input.structures.length - CAPS.structures
    const more = hidden > 0 ? `\n(${hidden} more — recall to find them)` : ''
    sections.push(`## Built — what really stands\n${list(input.structures.slice(0, CAPS.structures))}${more}`)
  }

  if (input.containers && input.containers.length > 0) {
    const hidden = input.containers.length - CAPS.containers
    const more = hidden > 0 ? `
(${hidden} more chests — look_in_chest or recall to find them)` : ''
    sections.push(`## Stored — in chests, as you last saw them
${list(input.containers.slice(0, CAPS.containers))}${more}`)
  }

  const skills = pickSkills(input.skills, input.focus ?? '', CAPS.skills)
  const hiddenSkills = input.skills.length - skills.length
  sections.push(
    `## Skills\n${list(skills.map((s) => `${s.name} — ${s.description} (${s.successes} ok, ${s.failures} failed)`))}${
      hiddenSkills > 0 ? `\n(${hiddenSkills} more skills not shown)` : ''
    }`,
  )

  if (input.templates && input.templates.length > 0) {
    const lines = input.templates
      .slice(0, CAPS.templates)
      .map((t) => `${t.name}: ${truncate(t.titles.join(' → '), 200)} (${t.successes} ok, ${t.failures} failed)`)
    sections.push(`## Plan templates that worked before — reuse one with set_goal { goal, template }\n${list(lines)}`)
  }

  // Changed every few steps, then every step.
  sections.push(input.goal ?? `## Goal\n(none — choose one with set_goal${input.goalNote ? `; ${input.goalNote}` : ''})`)
  sections.push(`## Situation\n${JSON.stringify(input.snapshot)}`)
  sections.push(`## Recent history today (oldest first)\n${list(input.history.slice(-CAPS.history).map((h) => `[${h.kind}] ${h.content}`))}`)
  if (input.chat.length > 0) sections.push(chatSection(input.chat))
  sections.push('Choose your next action: exactly one tool call.')
  return sections.join('\n\n')
}

export interface UpdateInput {
  snapshot: unknown
  /** The goal section, only when it changed since the model last saw it. */
  goal: string | null
  /** What happened since the last turn besides the model's own actions (events, chat, reflexes). */
  events: HistoryEntry[]
  chat: string[]
}

/** A turn in a running conversation: the model already knows the rest, so only what changed. */
export function buildUpdate(input: UpdateInput): string {
  const sections: string[] = []
  if (input.events.length > 0) sections.push(`## Since your last action\n${list(input.events.map((h) => `[${h.kind}] ${h.content}`))}`)
  if (input.goal) sections.push(input.goal)
  sections.push(`## Situation\n${JSON.stringify(input.snapshot)}`)
  if (input.chat.length > 0) sections.push(chatSection(input.chat))
  return sections.join('\n\n')
}

const chatSection = (chat: string[]): string =>
  `## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n${chat.join('\n')}`
