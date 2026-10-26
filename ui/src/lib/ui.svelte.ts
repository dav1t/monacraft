// Page-wide UI bits: toasts, the text prompt dialog and the item tooltip.
import type { SlotItem } from '../../../src/web/protocol.ts'

export interface Toast {
  id: number
  title: string
  text: string
  error: boolean
}

export const toasts = $state<Toast[]>([])
let nextToast = 1

export function toast(title: string, text: string, error = false): void {
  const id = nextToast++
  toasts.push({ id, title, text, error })
  setTimeout(
    () => {
      const index = toasts.findIndex((t) => t.id === id)
      if (index !== -1) toasts.splice(index, 1)
    },
    error ? 7000 : 3500,
  )
}

export const dialog = $state<{ open: boolean; title: string; value: string; resolve: (value: string | null) => void }>({
  open: false,
  title: '',
  value: '',
  resolve: () => {},
})

/** Minecraft-style text prompt; resolves with the trimmed text, or null when cancelled. */
export function ask(title: string, value = ''): Promise<string | null> {
  return new Promise((resolve) => Object.assign(dialog, { open: true, title, value, resolve }))
}

export const tooltip = $state<{ item: SlotItem | null; x: number; y: number }>({ item: null, x: 0, y: 0 })
