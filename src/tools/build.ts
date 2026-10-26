import { z } from 'zod'
import { facingFromYaw, normalizeSize, originInFront, shapeBlocks, SHAPES, toWorld, type Facing } from '../building/shapes.ts'
import { describeStructure, type Structure } from '../db/structures.ts'
import { Movements, Vec3 } from '../lib/mc.ts'
import { errorMessage } from '../lib/text.ts'
import { placeAt } from './building.ts'
import { defineTool, ToolError } from './types.ts'

/** Blocks that could not be placed, in a row, before the build gives up. */
const MAX_FAILURES = 12

const size = z.number().int().min(1).max(16).optional()
const coordinate = z.number().int().optional()

export const build = defineTool({
  name: 'build',
  description:
    'Build a whole structure of one block type: shelter (walls, a door gap and a roof), wall, floor or pillar. You choose the shape; every block is placed for you. ' +
    'It goes 2 blocks in front of you unless you give x y z (front-left corner). If it is interrupted, call build again with the same name to finish it.',
  schema: z.object({
    shape: z.enum(SHAPES),
    block: z.string().describe('e.g. oak_planks, cobblestone, dirt'),
    name: z.string().trim().min(2).max(40).optional().describe('defaults to the shape, e.g. "shelter"'),
    width: size,
    depth: size,
    height: size,
    x: coordinate,
    y: coordinate,
    z: coordinate,
  }),
  timeoutMs: 600_000,
  run: async (args, { bot, repos, signal }) => {
    const name = (args.name ?? args.shape).toLowerCase()
    const item = bot.registry.itemsByName[args.block]
    if (!item || !bot.registry.blocksByName[args.block]) throw new ToolError(`"${args.block}" is not a placeable block`)
    const coords = [args.x, args.y, args.z].filter((c) => c !== undefined).length
    if (coords !== 0 && coords !== 3) throw new ToolError('give all of x, y and z, or none of them')

    // Same name: continue that structure where it is. A new name: plan a new one.
    const existing = repos.structures.get(name)
    if (existing?.status === 'complete' && coords === 0) {
      return `${name} is already built: ${describeStructure(existing)}. Use another name to build a new one.`
    }
    let plan: Omit<Structure, 'total' | 'placed' | 'status' | 'created_at' | 'updated_at'>
    if (existing && coords === 0) {
      plan = { ...existing, block: args.block }
    } else {
      const facing: Facing = facingFromYaw(bot.entity.yaw)
      const dims = normalizeSize(args.shape, { width: args.width, depth: args.depth, height: args.height })
      const feet = bot.entity.position.floored()
      const origin = coords === 3 ? { x: args.x!, y: args.y!, z: args.z! } : originInFront(feet, facing, dims.width)
      plan = { name, shape: args.shape, block: args.block, ...origin, facing, ...dims }
    }

    const positions = shapeBlocks(plan.shape, plan).map((local) => {
      const p = toWorld(plan, plan.facing, local)
      return new Vec3(p.x, p.y, p.z)
    })
    // Anything solid already there (terrain, earlier blocks) counts as built.
    const filled = (p: Vec3): boolean => bot.blockAt(p)?.boundingBox === 'block'
    let todo = positions.filter((p) => !filled(p))
    const have = bot.inventory.count(item.id, null)
    if (todo.length > have) {
      const missing = todo.length - have
      throw new ToolError(
        `${name} needs ${todo.length} more ${args.block} (you have ${have}) — get ${missing} more first, e.g. plan_item { item: "${args.block}", count: ${missing} }`,
      )
    }

    const save = (): Structure['status'] => {
      const placed = positions.filter(filled).length
      const status = placed === positions.length ? 'complete' : 'building'
      repos.structures.save({ ...plan, total: positions.length, placed, status })
      return status
    }
    save()

    // Don't let the pathfinder tunnel through the walls being built.
    const movements = bot.pathfinder.movements
    const careful = new Movements(bot)
    careful.canDig = false
    bot.pathfinder.setMovements(careful)
    const problems: string[] = []
    try {
      // Two passes: a block without support in the first pass usually has a neighbour by the second.
      for (let pass = 0; pass < 2 && todo.length > 0; pass++) {
        const failed: Vec3[] = []
        let failures = 0
        for (const target of todo) {
          signal.throwIfAborted()
          if (filled(target)) continue
          try {
            await placeAt(bot, args.block, target, signal)
            failures = 0
          } catch (err) {
            if (signal.aborted) throw err
            failed.push(target)
            if (pass === 1) problems.push(errorMessage(err))
            if (++failures >= MAX_FAILURES) break
          }
        }
        todo = failed
      }
    } finally {
      bot.pathfinder.setMovements(movements)
      save()
    }

    const result = repos.structures.get(name)!
    if (result.status === 'complete') return `built ${describeStructure(result)}`
    const why = problems.length > 0 ? ` First problem: ${problems[0]}` : ''
    return `${describeStructure(result)} — some blocks could not be placed.${why} Clear the spot or move, then call build with name "${name}" again.`
  },
})
