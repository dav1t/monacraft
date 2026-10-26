import { toast } from './ui.svelte.ts'

/** JSON request to the panel server. Failures are shown as a toast and rethrown. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  // The server only accepts writes sent as JSON (so other sites can't post to it), even ones without data.
  const write = method !== 'GET' && method !== 'DELETE'
  const res = await fetch(path, {
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

/** SQLite `datetime('now')` values are UTC without a zone. */
export const sqlTime = (text: string): string => (text ? new Date(`${text.replace(' ', 'T')}Z`).toLocaleString() : '')
