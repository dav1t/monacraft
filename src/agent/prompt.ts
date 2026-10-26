import type { HistoryEntry, Skill } from '../db/repos.ts'

export function buildSystemPrompt(name: string): string {
  return `You are ${name}, a player in a Minecraft Java survival world. You act only through tools: every reply is exactly one tool call.

How to play:
- Survive first: keep food above 14, avoid or fight hostile mobs, be safe at night. Reflexes already eat and fight back automatically when needed.
- Players are your friends. When someone talks to you, answer with say (one short sentence) and help with what they ask.
- Always have a goal (set_goal). Typical progression: logs → planks → crafting_table → wooden_pickaxe → cobblestone → stone tools → food → shelter → furnace → iron tools.
- Use exact Minecraft ids: oak_log, oak_planks, cobblestone, raw_iron, crafting_table.
- mine takes the BLOCK name: mine stone → cobblestone, iron_ore → raw_iron, coal_ore → coal, oak_log → oak_log.
- Before exploring, check nearby_blocks and use find_blocks; explore in long hops (50+ blocks) only when nothing useful is near.
- Read the recent history. If an action failed, fix the cause (missing item, missing tool, too far away) instead of repeating it unchanged.
- Remember useful facts with remember: base location, crafting table and furnace positions, ores, villages.
- Narrate notable moments with say, but don't spam the chat.

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

export interface PromptInput {
  snapshot: unknown
  goal: string | null
  memory: Record<string, string>
  skills: Skill[]
  history: HistoryEntry[]
  chat: string[]
}

const list = (items: string[]): string => (items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '(none)')

export function buildUserPrompt(input: PromptInput): string {
  const sections = [
    `## Situation\n${JSON.stringify(input.snapshot)}`,
    `## Goal\n${input.goal ?? '(none — choose one with set_goal)'}`,
    `## Memory\n${list(Object.entries(input.memory).map(([key, value]) => `${key}: ${value}`))}`,
    `## Skills\n${list(input.skills.map((s) => `${s.name} — ${s.description} (${s.successes} ok, ${s.failures} failed)`))}`,
    `## Recent history (oldest first)\n${list(input.history.map((h) => `[${h.kind}] ${h.content}`))}`,
  ]
  if (input.chat.length > 0) sections.push(`## New chat — reply with say, or act on the request first (e.g. go_to_player) and reply after\n${input.chat.join('\n')}`)
  sections.push('Choose your next action: exactly one tool call.')
  return sections.join('\n\n')
}
