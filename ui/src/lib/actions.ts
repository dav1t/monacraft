import type { GoalStatus } from '../../../src/web/protocol.ts'
import { api } from './api.ts'
import { panel } from './panel.svelte.ts'
import { ask, toast } from './ui.svelte.ts'

/** Asks for a new goal; it replaces the current one (and gets a plan if it names an item). */
export async function editGoal(): Promise<void> {
  const goal = await ask('Set the bot’s goal (e.g. “get iron_pickaxe” or “build a shelter”)', panel.goals.tree?.goal.title ?? '')
  if (!goal) return
  try {
    await api('POST', '/api/goals', { title: goal })
    toast('Goal set', goal)
  } catch {
    // already shown
  }
}

export async function renameGoal(id: number, current: string): Promise<void> {
  const title = await ask('Rename', current)
  if (title && title !== current) await api('PUT', `/api/goals/${id}`, { title }).catch(() => {})
}

export function setGoalStatus(id: number, status: GoalStatus): void {
  api('PUT', `/api/goals/${id}`, { status }).catch(() => {})
}

export async function addGoalChild(parentId: number, what: string): Promise<void> {
  const title = await ask(`Add a ${what}`)
  if (title) await api('POST', `/api/goals/${parentId}/children`, { title }).catch(() => {})
}

export async function reveal(content: string): Promise<boolean> {
  try {
    await api('POST', '/api/revelations', { content })
    toast('Revelation sent', content)
    return true
  } catch {
    return false
  }
}
