export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Message of anything thrown, including errors from other realms (skills run in node:vm). */
export function errorMessage(err: unknown): string {
  const raw = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err)
  return raw.replace(/\s+/g, ' ').trim()
}
