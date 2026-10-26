import { api } from './api.ts'
import { panel } from './panel.svelte.ts'
import { ask, toast } from './ui.svelte.ts'

/** Asks for a new goal; an empty answer clears it. */
export async function editGoal(): Promise<void> {
  const goal = await ask('Set the bot’s goal', panel.memory.goal ?? '')
  if (goal === null) return
  try {
    if (goal === '') {
      if (panel.memory.goal !== undefined) await api('DELETE', '/api/memory/goal')
    } else await api('PUT', '/api/memory/goal', { value: goal })
    toast('Goal updated', goal || '(cleared)')
  } catch {
    // already shown
  }
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
