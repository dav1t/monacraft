export interface Point {
  x: number
  y: number
  z: number
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
/** Height differences from this many blocks are worth mentioning. */
const VERTICAL_BLOCKS = 3

/** Compass direction of an offset; in Minecraft north is -z and east is +x. */
export function compass(dx: number, dz: number): string {
  const eighth = Math.round(Math.atan2(dx, -dz) / (Math.PI / 4))
  return COMPASS[((eighth % 8) + 8) % 8] as string
}

/** Where `to` is from `from`: whole metres and a direction like `NE` or `SE, below`. */
export function relative(from: Point, to: Point): { distance: number; direction: string } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.round(Math.hypot(dx, dy, dz))
  const vertical = dy >= VERTICAL_BLOCKS ? 'above' : dy <= -VERTICAL_BLOCKS ? 'below' : ''
  if (Math.hypot(dx, dz) < 1) return { distance, direction: vertical || 'here' }
  return { distance, direction: vertical ? `${compass(dx, dz)}, ${vertical}` : compass(dx, dz) }
}
