import { z } from 'zod'
import { GoalKeeper, MAX_STEPS, MAX_SUBGOALS } from '../agent/goals.ts'
import { errorMessage } from '../lib/text.ts'
import { formatPlan, planItem } from '../planning/planner.ts'
import { botWorld } from '../planning/world.ts'
import { defineTool, ToolError, type ToolContext } from './types.ts'

function keeper({ bot, repos }: Pick<ToolContext, 'bot' | 'repos'>): GoalKeeper {
  return new GoalKeeper(repos, botWorld(bot))
}

/** Runs a goal change and answers with the updated goal section, so the model sees the plan at once. */
function withTree(ctx: ToolContext, change: (goals: GoalKeeper) => string): string {
  const goals = keeper(ctx)
  let result: string
  try {
    result = change(goals)
  } catch (err) {
    throw new ToolError(errorMessage(err))
  }
  const tree = goals.section()
  return tree ? `${result}\n${tree.replace(/^## /, '')}` : result
}

const titles = (max: number) => z.array(z.string().trim().min(2).max(200)).min(1).max(max)

export const planItemTool = defineTool({
  name: 'plan_item',
  description: 'Exact plan to get an item: what to gather (with tools), craft, smelt and place, in order, with a time estimate.',
  schema: z.object({ item: z.string(), count: z.number().int().min(1).max(2304).default(1) }),
  run: async ({ item, count }, { bot }) => {
    const world = botWorld(bot)
    if (!world) throw new ToolError('not in a world yet')
    if (!world.data.itemsByName[item]) throw new ToolError(`unknown item "${item}" — use the exact Minecraft id, e.g. stone_pickaxe`)
    return formatPlan(planItem(world.data, item, count, world.inventory(), world.stations()))
  },
})

export const setGoal = defineTool({
  name: 'set_goal',
  description:
    'Switch to another goal. Your current goal is paused with its plan, and set_goal with a paused goal\'s title resumes it. ' +
    'Name an item ("get iron_pickaxe", "get 24 iron_ingot") and the plan is made for you; otherwise follow with plan_goal.',
  schema: z.object({
    goal: z.string().trim().min(3).max(200),
    template: z.string().optional().describe('only the exact name of a template listed under "Plan templates"; leave out otherwise'),
  }),
  run: async ({ goal, template }, ctx) => withTree(ctx, (goals) => goals.setGoal(goal, template)),
})

export const planGoal = defineTool({
  name: 'plan_goal',
  description: `Set the sub-goals of your goal, in order (1-${MAX_SUBGOALS} short titles). Finished sub-goals are kept.`,
  schema: z.object({ subgoals: titles(MAX_SUBGOALS) }),
  run: async ({ subgoals }, ctx) => withTree(ctx, (goals) => goals.planGoal(subgoals)),
})

export const switchSubgoal = defineTool({
  name: 'switch_subgoal',
  description: 'Work on another open (or failed) sub-goal of your goal now; the current one stays open for later.',
  schema: z.object({ subgoal: z.string().trim().min(2).max(200).describe('its title as listed under your goal') }),
  run: async ({ subgoal }, ctx) => withTree(ctx, (goals) => goals.switchSubgoal(subgoal)),
})

export const setSteps = defineTool({
  name: 'set_steps',
  description: `Set the checklist for the current sub-goal (1-${MAX_STEPS} concrete steps, e.g. "mine oak_log x5").`,
  schema: z.object({ steps: titles(MAX_STEPS) }),
  run: async ({ steps }, ctx) => withTree(ctx, (goals) => goals.setSteps(steps)),
})

export const done = defineTool({
  name: 'done',
  description: 'Mark the current step done (or the sub-goal if it has no steps left) and move on.',
  schema: z.object({ note: z.string().max(300).optional() }),
  run: async ({ note }, ctx) => withTree(ctx, (goals) => goals.done(note)),
})

export const giveUp = defineTool({
  name: 'give_up',
  description: 'Mark the current sub-goal failed (it keeps failing or is impossible); then replan it with plan_goal.',
  schema: z.object({ reason: z.string().trim().min(3).max(300) }),
  run: async ({ reason }, ctx) => withTree(ctx, (goals) => goals.giveUp(reason)),
})
