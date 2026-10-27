import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { GoalKeeper, matchStep, parseItemGoal } from '../src/agent/goals.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import { loadRegistry } from '../src/planning/data.ts'
import type { Inventory } from '../src/planning/planner.ts'
import type { PlanningWorld } from '../src/planning/world.ts'

const data = loadRegistry('1.21.11')

function setup(inventory: Inventory = {}) {
  const repos = createRepos(openDatabase(':memory:'))
  const inv = { ...inventory }
  const world: PlanningWorld = { data, inventory: () => inv, stations: () => ({ craftingTable: false, furnace: false }) }
  const goals = new GoalKeeper(repos, world)
  const titles = () => {
    const tree = goals.tree()
    return tree ? tree.subgoals.map((s) => `${s.status}:${s.title}`) : []
  }
  const steps = () => goals.tree()?.subgoals.find((s) => s.status === 'active')?.steps.map((s) => `${s.status}:${s.title}`) ?? []
  const events = () => repos.history.recent(50).map((h) => h.content)
  return { repos, inv, goals, titles, steps, events }
}

describe('parseItemGoal', () => {
  it('recognises item goals in several phrasings', () => {
    expect(parseItemGoal(data, 'craft a stone pickaxe')).toEqual({ item: 'stone_pickaxe', count: 1 })
    expect(parseItemGoal(data, 'get 24 iron_ingot')).toEqual({ item: 'iron_ingot', count: 24 })
    expect(parseItemGoal(data, 'get iron_ingot x24')).toEqual({ item: 'iron_ingot', count: 24 })
    expect(parseItemGoal(data, 'collect oak logs')).toEqual({ item: 'oak_log', count: 1 })
    expect(parseItemGoal(data, 'build a shelter')).toBeNull()
    expect(parseItemGoal(data, 'get iron armor')).toBeNull()
  })
})

describe('matchStep', () => {
  it('ticks off planner-style steps from tool results', () => {
    expect(matchStep('craft stick x4 (from 2 oak_planks)', 'craft', { item: 'stick' }, 'ok: crafted 4 stick (now have 4)')).toBe('done')
    expect(matchStep('craft stick x8', 'craft', { item: 'stick' }, 'ok: crafted 4 stick (now have 4)')).toBeNull()
    expect(matchStep('mine stone x3 (needs wooden_pickaxe) → cobblestone', 'mine', { block_type: 'cobblestone' }, 'ok: mined 3 stone (drops cobblestone)')).toBe('done')
    expect(matchStep('mine oak_log x5', 'mine', { block_type: 'oak_log' }, 'ok: mined 2/5 oak_log')).toBe('mine oak_log x3')
    expect(matchStep('place crafting_table nearby', 'place', { block_type: 'crafting_table' }, 'ok: placed')).toBe('done')
    expect(matchStep('mine oak_log x5', 'craft', { item: 'oak_log' }, 'ok')).toBeNull()
    expect(matchStep('find a village', 'explore', {}, 'ok')).toBeNull()
  })
})

describe('GoalKeeper', () => {
  it('builds sub-goals and steps for a crafting goal without a model call', () => {
    const { goals, titles, steps } = setup()
    expect(goals.setGoal('get a stone pickaxe')).toBe('goal set: get a stone pickaxe')
    expect(titles()).toEqual(['active:get wooden_pickaxe', 'todo:get stone_pickaxe'])
    expect(steps()[0]).toBe('active:mine oak_log x3')
    expect(steps().at(-1)).toBe('todo:craft wooden_pickaxe x1 (from 3 oak_planks, 2 stick, at a crafting_table)')
    expect(goals.section()).toContain('## Goal: get a stone pickaxe (sub-goal 1/2)\n▶ get wooden_pickaxe (have 0/1)\n  ▶ mine oak_log x3')
    expect(goals.section()).toContain('\n☐ get stone_pickaxe')
  })

  it('advances steps from tool results and marks sub-goals done when the item is in the inventory', () => {
    const { goals, inv, titles, steps, events } = setup()
    goals.setGoal('get stone_pickaxe')
    goals.afterAction('mine', { block_type: 'oak_log', count: 3 }, 'ok: mined 3/3 oak_log')
    expect(steps().slice(0, 2)).toEqual(['done:mine oak_log x3', 'active:craft oak_planks x12 (from 3 oak_log)'])
    inv.wooden_pickaxe = 1
    goals.afterAction('craft', { item: 'wooden_pickaxe' }, 'ok: crafted 1 wooden_pickaxe (now have 1)')
    expect(titles()).toEqual(['done:get wooden_pickaxe', 'active:get stone_pickaxe'])
    // Fresh plan from the current inventory (only the pickaxe left): logs for sticks and a table, then stone.
    expect(steps()).toContain('todo:mine stone x3 (needs wooden_pickaxe) → cobblestone')
    expect(events()).toContain('sub-goal done: get wooden_pickaxe')
    inv.stone_pickaxe = 1
    goals.refresh()
    expect(goals.tree()).toBeNull()
    expect(events().at(-1)).toBe('goal reached: get stone_pickaxe — choose the next one with set_goal')
    expect(goals.lastGoalNote()).toBe('last goal reached: get stone_pickaxe')
  })

  it('warns after a step fails twice in a row', () => {
    const { goals, repos } = setup()
    goals.setGoal('get stone_pickaxe')
    goals.afterAction('mine', { block_type: 'oak_log' }, 'error: no reachable oak_log within 64 blocks')
    goals.afterAction('say', { message: 'hm' }, 'ok: sent')
    goals.afterAction('mine', { block_type: 'oak_log' }, 'error: no reachable oak_log within 64 blocks')
    expect(repos.history.recent(1)[0]?.content).toBe(
      'step "mine oak_log x3" failed 2 times in a row — revise the sub-goal (give_up) or change the steps (set_steps)',
    )
  })

  it('takes sub-goals and steps from the model for other goals, and saves them as templates', () => {
    const { goals, repos, titles, steps } = setup()
    goals.setGoal('build a shelter')
    expect(goals.needsPlan()).toBe(true)
    expect(goals.section()).toContain('(no plan yet')
    goals.planGoal(['find a flat spot', 'build walls'])
    expect(titles()).toEqual(['active:find a flat spot', 'todo:build walls'])
    expect(goals.section()).toContain('(no steps — set_steps')
    goals.done()
    goals.setSteps(['collect 20 dirt', 'place the walls'])
    expect(steps()).toEqual(['active:collect 20 dirt', 'todo:place the walls'])
    goals.done('got dirt')
    goals.done()
    expect(goals.tree()).toBeNull()
    expect(repos.templates.get('goal', 'Build a shelter')?.titles).toEqual(['find a flat spot', 'build walls'])
    expect(repos.templates.get('subgoal', 'build walls')?.titles).toEqual(['collect 20 dirt', 'place the walls'])
  })

  it('reuses templates: listed for similar goals, applied by name, steps for known sub-goals', () => {
    const { goals, repos, titles, steps } = setup()
    repos.templates.save('goal', 'build a shelter', ['find a flat spot', 'build walls'])
    repos.templates.save('subgoal', 'build walls', ['collect 20 dirt', 'place the walls'])
    expect(repos.templates.match('goal', 'build a small shelter', 3).map((t) => t.name)).toEqual(['build a shelter'])
    expect(repos.templates.match('goal', 'find diamonds', 3)).toEqual([])
    goals.setGoal('build a hut', 'build a shelter')
    expect(titles()).toEqual(['active:find a flat spot', 'todo:build walls'])
    goals.done()
    expect(steps()).toEqual(['active:collect 20 dirt', 'todo:place the walls'])
    expect(repos.templates.get('goal', 'build a shelter')?.uses).toBe(1)
    // A made-up template name is ignored; the goal is still replaced.
    expect(goals.setGoal('get stone_pickaxe', 'get item')).toBe('goal set: get stone_pickaxe (no plan template named "get item", so none was used) (paused: build a hut — set_goal with its title resumes it)')
    expect(repos.goals.active()?.title).toBe('get stone_pickaxe')
  })

  it('give_up fails the sub-goal until it is replanned; done sub-goals survive the replan', () => {
    const { goals, titles } = setup()
    goals.setGoal('find a village')
    goals.planGoal(['climb a hill', 'look around', 'walk there'])
    goals.done()
    expect(goals.giveUp('nothing visible')).toMatch(/^sub-goal failed: look around/)
    expect(goals.section()).toContain('✗ look around — failed: nothing visible')
    goals.refresh()
    // The bot carries on with the next sub-goal until it replans the failed one.
    expect(titles()).toEqual(['done:climb a hill', 'failed:look around', 'active:walk there'])
    goals.planGoal(['explore north'])
    expect(titles()).toEqual(['done:climb a hill', 'active:explore north'])
  })

  it('replaces the active goal and lets the panel edit the tree', () => {
    const { goals, repos, titles } = setup()
    goals.setGoal('find a village')
    const first = repos.goals.active()!
    goals.setGoal('build a shelter')
    expect(repos.goals.get(first.id)?.status).toBe('paused')
    const goal = repos.goals.active()!
    const sub = goals.addChild(goal.id, 'gather dirt')
    goals.addChild(goal.id, 'build walls')
    expect(titles()).toEqual(['active:gather dirt', 'todo:build walls'])
    goals.edit(sub.id, { status: 'done' })
    expect(titles()).toEqual(['done:gather dirt', 'active:build walls'])
    goals.edit(goal.id, { title: 'build a house' })
    expect(goals.tree()?.goal.title).toBe('build a house')
  })

  it('refuses sub-goals and steps that only repeat what is above them', () => {
    const { goals, repos, titles, steps } = setup()
    goals.setGoal('build a shelter')
    expect(() => goals.planGoal(['Build shelter', 'build a shelter!'])).toThrow(/repeats "build a shelter".*split it into smaller/)
    expect(goals.planGoal(['build a shelter', 'gather dirt', 'Gather  dirt', 'build walls'])).toBe(
      'sub-goals set (left out, they repeat what is above or each other: build a shelter; Gather  dirt)',
    )
    expect(titles()).toEqual(['active:gather dirt', 'todo:build walls'])
    // A step may not restate its sub-goal, nor the goal above that.
    expect(() => goals.setSteps(['gather dirt', 'a shelter build'])).toThrow(/repeats "gather dirt"/)
    goals.setSteps(['dig dirt x20'])
    expect(steps()).toEqual(['active:dig dirt x20'])
    const goal = repos.goals.active()!
    expect(() => goals.addChild(goal.id, 'build walls')).toThrow(/repeats/)
  })

  it('walks the parent chain without looping, even if it was damaged into a cycle', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    const a = repos.goals.create({ parentId: null, kind: 'goal', title: 'a', status: 'active' })
    const b = repos.goals.create({ parentId: a.id, kind: 'subgoal', title: 'b' })
    expect(repos.goals.lineage(b.id).map((r) => r.title)).toEqual(['b', 'a'])
    // No code path moves a node, but a hand-edited database could contain a cycle: a under b, b under a.
    db.prepare('UPDATE goals SET parent_id = ? WHERE id = ?').run(b.id, a.id)
    expect(repos.goals.lineage(b.id).map((r) => r.title)).toEqual(['b', 'a'])
    expect(() => new GoalKeeper(repos).planGoal(['b'])).not.toThrow(/Maximum call stack/)
  })

  it('works without a world: nothing is planned', () => {
    const repos = createRepos(openDatabase(':memory:'))
    const goals = new GoalKeeper(repos)
    goals.setGoal('get stone_pickaxe')
    expect(goals.section()).toBe('## Goal: get stone_pickaxe\n(no plan yet — call plan_goal with 2-8 sub-goals, or set_goal with an item name to get a plan)')
  })
})

describe('database migration', () => {
  it('moves memory.goal into the goal table and adds the pinned column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'monacraft-')), 'old.db')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE memory (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
              INSERT INTO memory (key, value) VALUES ('goal', 'get iron'), ('base', '0 64 0');`)
    old.close()
    const repos = createRepos(openDatabase(path))
    expect(repos.goals.active()?.title).toBe('get iron')
    expect(repos.memory.list()).toMatchObject([{ key: 'base', pinned: false }])
    expect(repos.memory.setPinned('base', true)).toBe(true)
    expect(repos.memory.isPinned('base')).toBe(true)
  })
})

describe('planning tools', () => {
  it('plan_item, set_goal and done answer with the plan and the updated tree', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.ts')
    const { allTools } = await import('../src/tools/index.ts')
    const repos = createRepos(openDatabase(':memory:'))
    const bot = { registry: data, inventory: { items: () => [{ name: 'oak_log', count: 2 }], slots: [] }, findBlock: () => null }
    const ctx = { bot: bot as never, repos, log: () => {}, signal: new AbortController().signal }
    const registry = new ToolRegistry().register(...allTools)
    const run = (tool: string, args: unknown) => registry.run(tool, args, ctx)

    const plan = await run('plan_item', { item: 'crafting_table' })
    expect(plan).toContain('have: 1 oak_log')
    expect(plan).toContain('1. craft oak_planks x4 (from 1 oak_log)')
    await expect(run('plan_item', { item: 'pickaxe' })).rejects.toThrow(/unknown item "pickaxe"/)

    expect(await run('set_goal', { goal: 'build a shelter' })).toContain('Goal: build a shelter\n(no plan yet')
    expect(await run('plan_goal', { subgoals: ['find a flat spot', 'build walls'] })).toContain('▶ find a flat spot')
    expect(await run('done', {})).toContain('sub-goal done: find a flat spot\nGoal: build a shelter (sub-goal 2/2)\n✓ find a flat spot\n▶ build walls')
    await expect(run('set_steps', { steps: [] })).rejects.toThrow(/invalid arguments/)
  })
})

describe('GoalKeeper freedom', () => {
  it('pauses the current goal for a new one and resumes it by title with its plan intact', () => {
    const { goals, repos, titles } = setup()
    goals.setGoal('find a village')
    goals.planGoal(['climb a hill', 'look around'])
    goals.done()
    const village = repos.goals.active()!
    expect(goals.setGoal('build a shelter')).toBe('goal set: build a shelter (paused: find a village — set_goal with its title resumes it)')
    expect(repos.goals.get(village.id)?.status).toBe('paused')
    expect(goals.section()).toContain('Paused goals (set_goal with the title resumes one): find a village')
    expect(goals.setGoal('Find a village')).toBe('goal resumed: find a village (paused: build a shelter — set_goal with its title resumes it)')
    expect(repos.goals.active()?.id).toBe(village.id)
    expect(titles()).toEqual(['done:climb a hill', 'active:look around'])
  })

  it('keeps only the newest paused goals', () => {
    const { goals, repos } = setup()
    for (const title of ['goal one', 'goal two', 'goal three', 'goal four', 'goal five', 'goal six', 'goal seven']) goals.setGoal(title)
    expect(repos.goals.paused().map((g) => g.title)).toEqual(['goal six', 'goal five', 'goal four', 'goal three', 'goal two'])
  })

  it('shows paused goals when no goal is active', () => {
    const { goals } = setup()
    goals.setGoal('find a village')
    goals.setGoal('build a shelter')
    goals.giveUp('no blocks')
    expect(goals.lastGoalNote()).toBe('last goal failed: build a shelter; paused: find a village (set_goal with the title resumes it)')
  })

  it('switches to any open sub-goal and keeps the current one open, in the full list', () => {
    const { goals, titles } = setup()
    goals.setGoal('prepare for the night')
    goals.planGoal(['build a shelter', 'get wool', 'craft a bed'])
    expect(goals.switchSubgoal('Craft bed')).toBe('now working on: craft a bed (build a shelter stays open)')
    expect(titles()).toEqual(['todo:build a shelter', 'todo:get wool', 'active:craft a bed'])
    expect(goals.section()).toContain('☐ build a shelter\n☐ get wool\n▶ craft a bed')
    goals.giveUp('no sheep')
    goals.refresh()
    expect(titles()).toEqual(['active:build a shelter', 'todo:get wool', 'failed:craft a bed'])
    // A failed sub-goal can be tried again later.
    goals.switchSubgoal('craft a bed')
    expect(titles()).toEqual(['todo:build a shelter', 'todo:get wool', 'active:craft a bed'])
    expect(() => goals.switchSubgoal('fly to the moon')).toThrow('no open sub-goal "fly to the moon"; open: build a shelter; get wool')
  })
})
