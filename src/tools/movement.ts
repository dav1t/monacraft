import { z } from 'zod'
import { biomeAt, formatPos, goals, moveTo } from '../lib/mc.ts'
import { defineTool, ToolError } from './types.ts'

export const goTo = defineTool({
  name: 'go_to',
  description: 'Walk to coordinates (pathfinding; may dig or pillar on the way).',
  schema: z.object({ x: z.number(), y: z.number(), z: z.number(), range: z.number().min(0).max(16).default(1) }),
  timeoutMs: 180_000,
  run: async ({ x, y, z, range }, { bot, signal }) => {
    await moveTo(bot, new goals.GoalNear(x, y, z, range), signal)
    return `arrived at ${formatPos(bot.entity.position)}`
  },
})

export const goToPlayer = defineTool({
  name: 'go_to_player',
  description: 'Walk next to a player.',
  schema: z.object({ name: z.string() }),
  timeoutMs: 180_000,
  run: async ({ name }, { bot, signal }) => {
    const player = bot.players[name]?.entity
    if (!player) throw new ToolError(`${name} is not within view distance (players in spectator mode are invisible to you)`)
    const { x, y, z } = player.position
    await moveTo(bot, new goals.GoalNear(x, y, z, 2), signal)
    return `next to ${name} at ${formatPos(bot.entity.position)}`
  },
})

const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const

export const explore = defineTool({
  name: 'explore',
  description: 'Travel a distance in a compass direction to discover new terrain.',
  schema: z.object({ direction: z.enum(['north', 'south', 'east', 'west']), distance: z.number().int().min(20).max(200).default(60) }),
  timeoutMs: 180_000,
  run: async ({ direction, distance }, { bot, signal }) => {
    const [dx, dz] = DIRECTIONS[direction]
    const start = bot.entity.position
    await moveTo(bot, new goals.GoalNearXZ(Math.round(start.x + dx * distance), Math.round(start.z + dz * distance), 3), signal)
    const here = bot.entity.position
    return `now at ${formatPos(here)} in ${biomeAt(bot, here)}`
  },
})
