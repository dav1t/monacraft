const STOP = new Set(['a', 'an', 'the', 'some', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'my', 'your', 'x'])

/** Lowercase content words: `get_iron armor!` → {get, iron, armor}. Plural s is dropped. */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
  )
}

/** Share of `pattern`'s words that also appear in `text` (0..1). */
export function overlap(text: string, pattern: string): number {
  const a = words(text)
  const b = words(pattern)
  if (b.size === 0) return 0
  let shared = 0
  for (const w of b) if (a.has(w)) shared++
  return shared / Math.max(a.size, b.size)
}

/** Normalised title, used as a template name: "Get Iron  Armor" → "get iron armor". */
export function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
