/** Simple structures as block positions. Pure geometry, so it is testable without a world. */

export const SHAPES = ['shelter', 'wall', 'floor', 'pillar'] as const
export type Shape = (typeof SHAPES)[number]

export interface Size {
  /** Across the bot's view (left to right). */
  width: number
  /** Away from the bot. */
  depth: number
  height: number
}

/** A block position relative to the structure's corner: x to the right, y up, z away from the bot. */
export interface Local {
  x: number
  y: number
  z: number
}

export type Facing = 'north' | 'south' | 'east' | 'west'

/** Unit step for each facing, in world x/z. North is -z, as in Minecraft. */
export const FACING_STEP: Record<Facing, { x: number; z: number }> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
}

/** The sizes that apply to a shape; the rest are fixed (a wall has depth 1, a floor height 1, a pillar is 1x1). */
export function normalizeSize(shape: Shape, size: Partial<Size>): Size {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, Math.round(value ?? fallback)))
  switch (shape) {
    case 'shelter':
      return { width: clamp(size.width, 5, 3, 9), depth: clamp(size.depth, 5, 3, 9), height: clamp(size.height, 3, 2, 5) }
    case 'wall':
      return { width: clamp(size.width, 5, 1, 16), depth: 1, height: clamp(size.height, 3, 1, 6) }
    case 'floor':
      return { width: clamp(size.width, 5, 1, 12), depth: clamp(size.depth, 5, 1, 12), height: 1 }
    case 'pillar':
      return { width: 1, depth: 1, height: clamp(size.height, 3, 1, 12) }
  }
}

/**
 * The blocks of a shape, in an order that can be placed: bottom layer first, and each roof from the walls inwards,
 * so every block has a neighbour to be placed against. A shelter has walls, a 2-high door gap in the middle of the
 * side facing the bot, and a flat roof; the ground is its floor.
 */
export function shapeBlocks(shape: Shape, size: Size): Local[] {
  const { width, depth, height } = size
  const blocks: Local[] = []
  if (shape === 'shelter') {
    const door = Math.floor(width / 2)
    for (let y = 0; y < height; y++) {
      for (const p of perimeter(width, depth)) {
        if (p.z === 0 && p.x === door && y < 2) continue
        blocks.push({ x: p.x, y, z: p.z })
      }
    }
    blocks.push(...rings(width, depth).map((p) => ({ x: p.x, y: height, z: p.z })))
    return blocks
  }
  if (shape === 'floor') return rings(width, depth).map((p) => ({ x: p.x, y: 0, z: p.z }))
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) blocks.push({ x, y, z })
    }
  }
  return blocks
}

/** The outline of a width x depth rectangle, going round once. */
function perimeter(width: number, depth: number): { x: number; z: number }[] {
  const cells: { x: number; z: number }[] = []
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) if (x === 0 || z === 0 || x === width - 1 || z === depth - 1) cells.push({ x, z })
  }
  return cells
}

/** Every cell of a rectangle, outer ring first, so a roof or floor grows from its edges inwards. */
function rings(width: number, depth: number): { x: number; z: number }[] {
  const cells: { x: number; z: number; ring: number }[] = []
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) cells.push({ x, z, ring: Math.min(x, z, width - 1 - x, depth - 1 - z) })
  }
  return cells.sort((a, b) => a.ring - b.ring).map(({ x, z }) => ({ x, z }))
}

/** World position of a local block: `origin` is the front-left corner, `facing` the direction away from the bot. */
export function toWorld(origin: { x: number; y: number; z: number }, facing: Facing, local: Local): { x: number; y: number; z: number } {
  const forward = FACING_STEP[facing]
  // Right-hand side when looking along `forward` (north → east, east → south…).
  const right = { x: -forward.z, z: forward.x }
  return {
    x: origin.x + right.x * local.x + forward.x * local.z,
    y: origin.y + local.y,
    z: origin.z + right.z * local.x + forward.z * local.z,
  }
}

/**
 * Where to put a structure in front of the bot: its front edge two blocks ahead, centred on the bot. Returns the
 * front-left corner.
 */
export function originInFront(feet: { x: number; y: number; z: number }, facing: Facing, width: number): { x: number; y: number; z: number } {
  const forward = FACING_STEP[facing]
  const right = { x: -forward.z, z: forward.x }
  const half = Math.floor(width / 2)
  return {
    x: feet.x + forward.x * 2 - right.x * half,
    y: feet.y,
    z: feet.z + forward.z * 2 - right.z * half,
  }
}

/** mineflayer yaw (0 = north, turning counter-clockwise) to the nearest compass direction. */
export function facingFromYaw(yaw: number): Facing {
  const quarter = (((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4) as 0 | 1 | 2 | 3
  return (['north', 'west', 'south', 'east'] as const)[quarter]
}
