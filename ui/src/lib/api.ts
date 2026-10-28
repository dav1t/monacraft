import { toast } from './ui.svelte.ts'

let bot = ''

/** Sends per-bot requests to this bot. */
export function useBot(id: string): void {
  bot = id
}

/** A bot route (`/api/memory`) as served for the selected bot (`/api/bots/<id>/memory`); the bot list's own routes pass through. */
export function botPath(path: string): string {
  if (!path.startsWith('/api/') || path === '/api/bots' || path.startsWith('/api/bots/') || path.startsWith('/api/icons/')) return path
  return `/api/bots/${encodeURIComponent(bot)}${path.slice(4)}`
}

/** JSON request to the panel server; bot routes go to the selected bot. Failures are shown as a toast and rethrown. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  // The server only accepts writes sent as JSON (so other sites can't post to it), even ones without data.
  const write = method !== 'GET' && method !== 'DELETE'
  const res = await fetch(botPath(path), {
    method,
    headers: write ? { 'content-type': 'application/json' } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    const message = data.error ?? `${res.status} ${res.statusText}`
    toast('Something went wrong', message, true)
    throw new Error(message)
  }
  return data as T
}

/** Runs an action and swallows its error (the api helper already showed it). */
export function attempt(action: () => Promise<unknown>): void {
  action().catch(() => {})
}

export const time = (ms: number): string => new Date(ms).toLocaleTimeString()

/** A cost in USD, or a dash when the provider reported none. */
export const usd = (cost: number | null | undefined): string => (cost === null || cost === undefined ? '—' : `$${cost.toFixed(4)}`)

/** SQLite `datetime('now')` values are UTC without a zone. */
export const sqlTime = (text: string): string => (text ? new Date(`${text.replace(' ', 'T')}Z`).toLocaleString() : '')
