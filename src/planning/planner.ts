import { blockDrops, digTime, recipeItemId, recipeResult, type McBlock, type McData } from './data.ts'

// Cost constants (seconds). Travel is not measured: every gathering trip costs the same.
export const TRAVEL_SECONDS = 20
export const CRAFT_SECONDS = 2
export const PLACE_SECONDS = 2
export const SMELT_SECONDS = 10
export const MOB_SECONDS = 15
/** Gathers of at least this many blocks are checked for "make a faster tool first". */
export const TOOL_ADVICE_MIN_BLOCKS = 8
/** A faster tool must save at least this much time to be worth it. */
const TOOL_ADVICE_MIN_GAIN = 5
/** Tools needed to make tools needed to make tools… */
const MAX_TOOL_DEPTH = 6

/** Smelting is not in minecraft-data. Output → input alternatives (logs are filled in from the registry). */
const SMELTS: Record<string, string[]> = {
  iron_ingot: ['raw_iron'],
  gold_ingot: ['raw_gold'],
  copper_ingot: ['raw_copper'],
  glass: ['sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  brick: ['clay_ball'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_mutton: ['mutton'],
  cooked_chicken: ['chicken'],
  cooked_rabbit: ['rabbit'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  baked_potato: ['potato'],
  dried_kelp: ['kelp'],
  charcoal: [],
}

/** Natural resources: always gathered, even when a recipe exists (e.g. coal from coal_block). */
const BASE = new Set([
  'cobblestone', 'cobbled_deepslate', 'blackstone', 'dirt', 'sand', 'red_sand', 'gravel', 'flint', 'clay_ball', 'coal',
  'raw_iron', 'raw_gold', 'raw_copper', 'diamond', 'emerald', 'redstone', 'lapis_lazuli', 'quartz', 'amethyst_shard',
  'obsidian', 'string', 'leather', 'feather', 'bone', 'gunpowder', 'slime_ball', 'ender_pearl', 'blaze_rod', 'egg', 'wheat',
  'wheat_seeds', 'sugar_cane', 'apple', 'carrot', 'potato', 'beetroot', 'melon_slice', 'pumpkin', 'bamboo', 'cactus', 'kelp',
  'ink_sac', 'white_wool', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'rotten_flesh', 'spider_eye',
  'snowball', 'ice', 'netherrack', 'soul_sand', 'glowstone_dust', 'nether_wart', 'andesite', 'diorite', 'granite', 'tuff',
])
const isBase = (name: string): boolean => BASE.has(name) || /_(log|stem)$/.test(name)

/** Items that come from mobs, and which mob. */
const MOB_DROPS: Record<string, string> = {
  string: 'spider', leather: 'cow', feather: 'chicken', bone: 'skeleton', gunpowder: 'creeper', slime_ball: 'slime',
  ender_pearl: 'enderman', blaze_rod: 'blaze', egg: 'chicken', white_wool: 'sheep', beef: 'cow', porkchop: 'pig',
  mutton: 'sheep', chicken: 'chicken', rabbit: 'rabbit', rotten_flesh: 'zombie', spider_eye: 'spider', ink_sac: 'squid',
  cod: 'cod', salmon: 'salmon',
}

/** The usual block to mine for an item, where it is not the block of the same name. */
const MINE_FROM: Record<string, string> = {
  cobblestone: 'stone', cobbled_deepslate: 'deepslate', coal: 'coal_ore', raw_iron: 'iron_ore', raw_gold: 'gold_ore',
  raw_copper: 'copper_ore', diamond: 'diamond_ore', emerald: 'emerald_ore', redstone: 'redstone_ore', lapis_lazuli: 'lapis_ore',
  quartz: 'nether_quartz_ore', flint: 'gravel', clay_ball: 'clay', glowstone_dust: 'glowstone', apple: 'oak_leaves',
  wheat_seeds: 'short_grass', amethyst_shard: 'amethyst_cluster',
}

/** Cheapest tiers first: the tool the planner adds when a block needs one. */
const TIERS = ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite']
/** Tiers worth making just to dig faster. */
const SPEED_TIERS = ['wooden', 'stone', 'iron']
const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']
const PREFERRED = ['oak_planks', 'oak_log', 'cobblestone', 'coal', 'stick']

export const isTool = (name: string): boolean => TOOL_TYPES.some((t) => name.endsWith(`_${t}`)) || name === 'shears'

export interface Stations {
  /** A crafting table within 32 blocks. */
  craftingTable: boolean
  /** A furnace within 32 blocks. */
  furnace: boolean
}

export type Inventory = Record<string, number>

export type PlanStep =
  | { kind: 'mine'; item: string; count: number; block: string; tool: string | null; advice?: string; seconds: number }
  | { kind: 'hunt'; item: string; count: number; mob: string; seconds: number }
  | { kind: 'find'; item: string; count: number; seconds: number }
  | { kind: 'craft'; item: string; count: number; times: number; inputs: Inventory; table: boolean; seconds: number }
  | { kind: 'smelt'; item: string; count: number; input: string; fuel: Inventory; seconds: number }
  | { kind: 'place'; item: 'crafting_table' | 'furnace'; seconds: number }

export interface Plan {
  target: string
  count: number
  steps: PlanStep[]
  /** Items from the inventory the plan uses (consumed, or tools it relies on). */
  have: Inventory
  /** Everything gathered, summed, for one batched trip. */
  raw: Inventory
  /** Tools the plan makes on the way (prerequisites or speed-ups), in order. */
  tools: string[]
  notes: string[]
  seconds: number
}

/** A normalised recipe: each slot accepts any of `alts` (e.g. any planks). */
interface Recipe {
  makes: number
  slots: { alts: string[]; count: number }[]
  table: boolean
}

class Cycle extends Error {}

interface Saved {
  inv: Inventory
  steps: number
  placed: { craftingTable: boolean; furnace: boolean }
  tools: number
  notes: number
}

const recipeCache = new WeakMap<McData, Map<string, Recipe[]>>()

/**
 * Crafting recipes for an item. minecraft-data lists one recipe per wood type (or stone type); recipes with the same shape
 * are merged so each varying slot accepts any of the variants.
 */
export function recipesFor(data: McData, item: string): Recipe[] {
  let cache = recipeCache.get(data)
  if (!cache) recipeCache.set(data, (cache = new Map()))
  const cached = cache.get(item)
  if (cached) return cached
  const id = data.itemsByName[item]?.id
  const raw = id === undefined ? [] : (data.recipes[id] ?? [])
  const groups = new Map<string, { makes: number; table: boolean; cells: Set<number>[] }>()
  for (const recipe of raw as { inShape?: unknown[][]; ingredients?: unknown[]; result: unknown }[]) {
    const result = recipeResult(recipe.result)
    if (!result || result.id !== id) continue
    let cells: (number | null)[]
    let shapeKey: string
    let table: boolean
    if (recipe.inShape) {
      cells = recipe.inShape.flatMap((row) => row.map(recipeItemId))
      shapeKey = `s${recipe.inShape.map((row) => row.map((c) => (recipeItemId(c) === null ? '.' : 'x')).join('')).join('/')}`
      table = recipe.inShape.length > 2 || recipe.inShape.some((row) => row.length > 2)
    } else if (recipe.ingredients) {
      cells = recipe.ingredients.map(recipeItemId)
      shapeKey = `l${cells.length}`
      table = cells.length > 4
    } else continue
    const key = `${shapeKey}:${result.count}`
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { makes: result.count, table, cells: cells.map(() => new Set<number>()) }))
    cells.forEach((cell, i) => cell !== null && group.cells[i]?.add(cell))
  }
  const recipes: Recipe[] = []
  for (const group of groups.values()) {
    const slots = new Map<string, { alts: string[]; count: number }>()
    for (const cell of group.cells) {
      if (cell.size === 0) continue
      const alts = [...cell].map((i) => data.items[i]?.name).filter((n): n is string => !!n)
      const key = [...alts].sort().join(',')
      const slot = slots.get(key)
      if (slot) slot.count++
      else slots.set(key, { alts: sortAlts(alts), count: 1 })
    }
    recipes.push({ makes: group.makes, table: group.table, slots: [...slots.values()] })
  }
  cache.set(item, recipes)
  return recipes
}

function sortAlts(alts: string[]): string[] {
  const rank = (name: string): number => {
    const i = PREFERRED.indexOf(name)
    return i === -1 ? (isBase(name) ? PREFERRED.length : PREFERRED.length + 1) : i
  }
  return [...alts].sort((a, b) => rank(a) - rank(b))
}

const add = (inv: Inventory, item: string, n: number): void => {
  inv[item] = (inv[item] ?? 0) + n
  if (inv[item] === 0) delete inv[item]
}

/** Builds a plan depth-first, simulating the inventory as it goes. */
class Planner {
  readonly #data: McData
  readonly #initial: Inventory
  #inv: Inventory
  #steps: PlanStep[] = []
  #placed = { craftingTable: false, furnace: false }
  #stack: string[] = []
  #toolDepth = 0
  #tools: string[] = []
  #notes: string[] = []
  #advice: boolean
  readonly #stations: Stations

  constructor(data: McData, inventory: Inventory, stations: Stations, advice = true) {
    this.#data = data
    this.#initial = { ...inventory }
    this.#inv = { ...inventory }
    this.#stations = stations
    this.#advice = advice
  }

  plan(target: string, count: number): Plan {
    if (!this.#data.itemsByName[target]) throw new Error(`unknown item "${target}"`)
    this.#obtain([target], count)
    const steps = mergeSteps(hoistGathers(this.#steps), this.#initial, this.#stations)
    estimateSteps(this.#data, steps, this.#initial)
    return {
      target,
      count,
      steps,
      have: usedFromInventory(steps, this.#initial),
      raw: rawNeeds(steps),
      tools: this.#tools,
      notes: this.#notes,
      seconds: steps.reduce((sum, s) => sum + s.seconds, 0),
    }
  }

  /** Make `count` of any of `alts` available, taking from the inventory first. Returns what was consumed. */
  #obtain(alts: string[], count: number): Inventory {
    const used: Inventory = {}
    let need = count
    // Use what is there, largest stacks first.
    for (const name of [...alts].sort((a, b) => (this.#inv[b] ?? 0) - (this.#inv[a] ?? 0))) {
      const take = Math.min(need, this.#inv[name] ?? 0)
      if (take <= 0) continue
      add(this.#inv, name, -take)
      add(used, name, take)
      need -= take
    }
    if (need > 0) {
      const item = this.#choose(alts)
      this.#produce(item, need)
      add(this.#inv, item, -need)
      add(used, item, need)
    }
    return used
  }

  /** Which variant to make: the one whose inputs the bot has most of, then the preferred one. */
  #choose(alts: string[]): string {
    if (alts.length === 1) return alts[0]!
    let best = alts[0]!
    let bestScore = -1
    for (const name of alts) {
      const recipe = recipesFor(this.#data, name)[0]
      const smelt = SMELTS[name]
      const inputs = recipe ? recipe.slots.flatMap((s) => s.alts) : (smelt ?? [])
      const score = inputs.reduce((sum, input) => sum + (this.#inv[input] ?? 0), 0)
      if (score > bestScore) {
        best = name
        bestScore = score
      }
    }
    return best
  }

  /** Add steps that put `count` more of `item` into the simulated inventory (it may make more). */
  #produce(item: string, count: number): void {
    if (this.#stack.includes(item)) throw new Cycle(item)
    this.#stack.push(item)
    try {
      if (isBase(item)) return this.#gather(item, count)
      if (item in SMELTS) return this.#smelt(item, count)
      if (this.#craft(item, count)) return
      // Every recipe loops back to something being made already (e.g. coal_block → coal).
      if (recipesFor(this.#data, item).length > 0) throw new Cycle(item)
      this.#gather(item, count)
    } finally {
      this.#stack.pop()
    }
  }

  #craft(item: string, count: number): boolean {
    const recipes = [...recipesFor(this.#data, item)].sort((a, b) => this.#coverage(b) - this.#coverage(a))
    for (const recipe of recipes) {
      const saved = this.#save()
      try {
        const times = Math.ceil(count / recipe.makes)
        const inputs: Inventory = {}
        for (const slot of recipe.slots) {
          for (const [name, n] of Object.entries(this.#obtain(slot.alts, slot.count * times))) add(inputs, name, n)
        }
        if (recipe.table) this.#station('craftingTable')
        this.#steps.push({ kind: 'craft', item, count: times * recipe.makes, times, inputs, table: recipe.table, seconds: 0 })
        add(this.#inv, item, times * recipe.makes)
        return true
      } catch (err) {
        if (!(err instanceof Cycle)) throw err
        this.#restore(saved)
      }
    }
    return false
  }

  /** How much of a recipe's inputs the inventory already covers. */
  #coverage(recipe: Recipe): number {
    return recipe.slots.reduce((sum, s) => sum + Math.min(s.count, s.alts.reduce((n, a) => n + (this.#inv[a] ?? 0), 0)), 0)
  }

  #smelt(item: string, count: number): void {
    const inputs = SMELTS[item]!.length > 0 ? SMELTS[item]! : this.#names(/_(log|wood)$/)
    const used = this.#obtain(sortAlts(inputs), count)
    const fuel: Inventory = {}
    let left = count
    for (const coal of ['coal', 'charcoal']) {
      const n = Math.min(this.#inv[coal] ?? 0, Math.ceil(left / 8))
      if (n <= 0) continue
      add(this.#inv, coal, -n)
      add(fuel, coal, n)
      left = Math.max(0, left - n * 8)
    }
    if (left > 0) {
      for (const [name, n] of Object.entries(this.#obtain(sortAlts(this.#names(/_planks$/)), Math.ceil(left / 1.5)))) add(fuel, name, n)
    }
    this.#station('furnace')
    Object.entries(used).forEach(([input, n], i) => {
      this.#steps.push({ kind: 'smelt', item, count: n, input, fuel: i === 0 ? fuel : {}, seconds: 0 })
    })
    add(this.#inv, item, count)
  }

  #gather(item: string, count: number): void {
    const mob = MOB_DROPS[item]
    if (mob) {
      this.#steps.push({ kind: 'hunt', item, count, mob, seconds: 0 })
      add(this.#inv, item, count)
      return
    }
    const block = this.#sourceBlock(item)
    if (!block) {
      this.#steps.push({ kind: 'find', item, count, seconds: 0 })
      add(this.#inv, item, count)
      return
    }
    let tool: string | null = null
    let advice: string | undefined
    const required = Object.keys(block.harvestTools ?? {}).map((id) => this.#data.items[Number(id)]?.name).filter((n): n is string => !!n)
    if (required.length > 0) {
      tool = required.find((t) => (this.#inv[t] ?? 0) > 0) ?? null
      if (!tool) {
        tool = this.#cheapest(required)
        this.#makeTool(tool)
      }
    }
    if (this.#advice && count >= TOOL_ADVICE_MIN_BLOCKS) {
      const faster = this.#fasterTool(block, count)
      if (faster) {
        this.#makeTool(faster.tool)
        tool = faster.tool
        advice = faster.note
        this.#notes.push(`make ${faster.tool} first: ${faster.note}`)
      }
    }
    this.#steps.push({ kind: 'mine', item, count, block: block.name, tool, ...(advice && { advice }), seconds: 0 })
    add(this.#inv, item, count)
  }

  /** A tool is its own chain: what is being gathered when it is needed does not make it circular. */
  #makeTool(tool: string): void {
    if (this.#toolDepth >= MAX_TOOL_DEPTH) throw new Cycle(tool)
    const advice = this.#advice
    const stack = this.#stack
    this.#advice = false
    this.#stack = []
    this.#toolDepth++
    try {
      this.#produce(tool, 1)
    } finally {
      this.#advice = advice
      this.#stack = stack
      this.#toolDepth--
    }
    if (!this.#tools.includes(tool)) this.#tools.push(tool)
  }

  /** Whether making a better tool first beats gathering with what the bot has. */
  #fasterTool(block: McBlock, count: number): { tool: string; note: string } | null {
    const type = toolType(block)
    if (!type) return null
    const current = bestTool(this.#data, block.name, Object.keys(this.#inv).filter((n) => (this.#inv[n] ?? 0) > 0 && isTool(n)))
    const now = (count * digTime(this.#data, block.name, current)) / 1000
    let best: { tool: string; total: number; dig: number; cost: number } | null = null
    for (const tier of SPEED_TIERS) {
      const tool = `${tier}_${type}`
      if (!this.#data.itemsByName[tool] || (this.#inv[tool] ?? 0) > 0 || this.#stack.includes(tool)) continue
      const dig = (count * digTime(this.#data, block.name, tool)) / 1000
      if (dig >= now) continue
      let cost: number
      try {
        const stations = { craftingTable: this.#stations.craftingTable || this.#placed.craftingTable, furnace: this.#stations.furnace || this.#placed.furnace }
        cost = new Planner(this.#data, this.#inv, stations, false).plan(tool, 1).seconds
      } catch {
        continue
      }
      if (!best || cost + dig < best.total) best = { tool, total: cost + dig, dig, cost }
    }
    if (!best || now - best.total < TOOL_ADVICE_MIN_GAIN) return null
    const note = `${count} ${block.name} ${Math.round(now)} s → ${Math.round(best.dig)} s, ${best.tool} costs ~${Math.round(best.cost)} s`
    return { tool: best.tool, note }
  }

  #cheapest(tools: string[]): string {
    const tier = (name: string): number => {
      const i = TIERS.findIndex((t) => name.startsWith(`${t}_`))
      return i === -1 ? TIERS.length : i
    }
    return [...tools].sort((a, b) => tier(a) - tier(b))[0]!
  }

  #sourceBlock(item: string): McBlock | null {
    const blocks = this.#data.blocksByName
    const preferred = MINE_FROM[item]
    if (preferred && blocks[preferred]) return blocks[preferred]
    const id = this.#data.itemsByName[item]?.id
    if (id === undefined) return null
    const same = blocks[item]
    if (same && blockDrops(same).includes(id)) return same
    const dropping = this.#data.blocksArray.filter((b) => blockDrops(b).includes(id))
    return dropping.find((b) => !b.name.startsWith('deepslate_')) ?? dropping[0] ?? null
  }

  #station(which: keyof Stations): void {
    if (this.#stations[which] || this.#placed[which]) return
    const item = which === 'craftingTable' ? 'crafting_table' : 'furnace'
    this.#obtain([item], 1)
    this.#steps.push({ kind: 'place', item, seconds: 0 })
    this.#placed[which] = true
  }

  #names(pattern: RegExp): string[] {
    return Object.keys(this.#data.itemsByName).filter((n) => pattern.test(n))
  }

  #save(): Saved {
    return { inv: { ...this.#inv }, steps: this.#steps.length, placed: { ...this.#placed }, tools: this.#tools.length, notes: this.#notes.length }
  }

  #restore(saved: Saved): void {
    this.#inv = saved.inv
    this.#steps.length = saved.steps
    this.#placed = saved.placed
    this.#tools.length = saved.tools
    this.#notes.length = saved.notes
  }
}

function toolType(block: McBlock): string | null {
  const tools = Object.keys(block.harvestTools ?? {})
  if (tools.length > 0 || block.material?.startsWith('incorrect_for')) return 'pickaxe'
  return /mineable\/(\w+)/.exec(block.material ?? '')?.[1] ?? null
}

function bestTool(data: McData, block: string, tools: string[]): string | null {
  let best: string | null = null
  let time = digTime(data, block, null)
  for (const tool of tools) {
    const t = digTime(data, block, tool)
    if (t < time) {
      best = tool
      time = t
    }
  }
  return best
}

function consumes(step: PlanStep): Inventory {
  switch (step.kind) {
    case 'craft':
      return step.inputs
    case 'smelt': {
      const inv: Inventory = { ...step.fuel }
      add(inv, step.input, step.count)
      return inv
    }
    case 'place':
      return { [step.item]: 1 }
    default:
      return {}
  }
}

function produces(step: PlanStep): Inventory {
  return step.kind === 'place' ? {} : { [step.item]: step.count }
}

/** Replays steps on an inventory; false if a step lacks inputs, its tool or its station. */
function simulate(steps: PlanStep[], initial: Inventory, stations: Stations): boolean {
  const inv = { ...initial }
  const placed = { ...stations }
  for (const step of steps) {
    for (const [name, n] of Object.entries(consumes(step))) {
      if ((inv[name] ?? 0) < n) return false
      add(inv, name, -n)
    }
    if (step.kind === 'mine' && step.tool && (inv[step.tool] ?? 0) <= 0) return false
    if (step.kind === 'craft' && step.table && !placed.craftingTable) return false
    if (step.kind === 'smelt' && !placed.furnace) return false
    if (step.kind === 'place') placed[step.item === 'crafting_table' ? 'craftingTable' : 'furnace'] = true
    for (const [name, n] of Object.entries(produces(step))) add(inv, name, n)
  }
  return true
}

/** Gathers that need no tool move to the front, so one trip collects them. */
function hoistGathers(steps: PlanStep[]): PlanStep[] {
  const free = (s: PlanStep): boolean => s.kind === 'hunt' || s.kind === 'find' || (s.kind === 'mine' && !s.tool)
  return [...steps.filter(free), ...steps.filter((s) => !free(s))]
}

/** Folds repeated steps (same item, same way) into the first one when the plan stays valid. */
function mergeSteps(steps: PlanStep[], initial: Inventory, stations: Stations): PlanStep[] {
  const key = (s: PlanStep): string => {
    switch (s.kind) {
      case 'mine':
        return `mine:${s.item}:${s.block}:${s.tool}`
      case 'craft':
        return `craft:${s.item}:${Object.keys(s.inputs).sort().join(',')}`
      case 'smelt':
        return `smelt:${s.item}:${s.input}`
      case 'place':
        return `place:${s.item}:${Math.random()}`
      default:
        return `${s.kind}:${s.item}`
    }
  }
  let result = steps.map((s) => structuredClone(s))
  for (let j = 1; j < result.length; j++) {
    const later = result[j]!
    for (let i = 0; i < j; i++) {
      const earlier = result[i]!
      if (key(earlier) !== key(later)) continue
      const merged = structuredClone(earlier)
      combine(merged, later)
      const candidate = [...result.slice(0, i), merged, ...result.slice(i + 1, j), ...result.slice(j + 1)]
      if (simulate(candidate, initial, stations)) {
        result = candidate
        j--
        break
      }
    }
  }
  return result
}

function combine(into: PlanStep, from: PlanStep): void {
  if (into.kind === 'place' || from.kind === 'place') return
  into.count += from.count
  if (into.kind === 'craft' && from.kind === 'craft') {
    into.times += from.times
    for (const [name, n] of Object.entries(from.inputs)) add(into.inputs, name, n)
  }
  if (into.kind === 'smelt' && from.kind === 'smelt') {
    for (const [name, n] of Object.entries(from.fuel)) add(into.fuel, name, n)
  }
}

/** Fills in each step's time, digging with the best tool the bot holds at that point. */
function estimateSteps(data: McData, steps: PlanStep[], initial: Inventory): void {
  const inv = { ...initial }
  for (const step of steps) {
    switch (step.kind) {
      case 'mine': {
        const tools = Object.keys(inv).filter((n) => (inv[n] ?? 0) > 0 && isTool(n))
        step.seconds = TRAVEL_SECONDS + (step.count * digTime(data, step.block, bestTool(data, step.block, tools))) / 1000
        break
      }
      case 'hunt':
        step.seconds = TRAVEL_SECONDS + step.count * MOB_SECONDS
        break
      case 'find':
        step.seconds = TRAVEL_SECONDS * 3
        break
      case 'craft':
        step.seconds = CRAFT_SECONDS
        break
      case 'smelt':
        step.seconds = SMELT_SECONDS * step.count
        break
      case 'place':
        step.seconds = PLACE_SECONDS
        break
    }
    for (const [name, n] of Object.entries(consumes(step))) add(inv, name, -n)
    for (const [name, n] of Object.entries(produces(step))) add(inv, name, n)
  }
}

export function estimate(plan: Pick<Plan, 'steps'>): number {
  return plan.steps.reduce((sum, s) => sum + s.seconds, 0)
}

function usedFromInventory(steps: PlanStep[], initial: Inventory): Inventory {
  const consumed: Inventory = {}
  for (const step of steps) {
    for (const [name, n] of Object.entries(consumes(step))) add(consumed, name, n)
    if (step.kind === 'mine' && step.tool && (initial[step.tool] ?? 0) > 0) consumed[step.tool] = 1
  }
  const have: Inventory = {}
  for (const [name, n] of Object.entries(consumed)) {
    const from = Math.min(n, initial[name] ?? 0)
    if (from > 0) have[name] = from
  }
  return have
}

function rawNeeds(steps: PlanStep[]): Inventory {
  const raw: Inventory = {}
  for (const step of steps) if (step.kind === 'mine' || step.kind === 'hunt' || step.kind === 'find') add(raw, step.item, step.count)
  return raw
}

/** Everything needed to get `count` of `target`, given the inventory and nearby stations. */
export function planItem(data: McData, target: string, count: number, inventory: Inventory, stations: Stations): Plan {
  const have = inventory[target] ?? 0
  if (have >= count) return { target, count, steps: [], have: { [target]: count }, raw: {}, tools: [], notes: [], seconds: 0 }
  // Items already held count towards the target and must not be used up as ingredients.
  const rest = { ...inventory }
  delete rest[target]
  const plan = new Planner(data, rest, stations).plan(target, count - have)
  if (have > 0) plan.have[target] = have
  plan.count = count
  return plan
}

const list = (inv: Inventory): string =>
  Object.entries(inv)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ')

/** One line per step, e.g. `mine stone x3 (needs wooden_pickaxe) → cobblestone`. */
export function describeStep(step: PlanStep): string {
  switch (step.kind) {
    case 'mine': {
      const drop = step.block === step.item ? '' : ` → ${step.item}`
      const tool = step.advice ? ` (with ${step.tool}: ${step.advice})` : step.tool ? ` (needs ${step.tool})` : ''
      return `mine ${step.block} x${step.count}${tool}${drop}`
    }
    case 'hunt':
      return `get ${step.item} x${step.count} (from ${step.mob})`
    case 'find':
      return `get ${step.item} x${step.count} (find it)`
    case 'craft':
      return `craft ${step.item} x${step.count} (from ${list(step.inputs)}${step.table ? ', at a crafting_table' : ''})`
    case 'smelt':
      return `smelt ${step.input} x${step.count} → ${step.item} (fuel: ${list(step.fuel) || 'in the furnace'})`
    case 'place':
      return `place ${step.item} nearby`
  }
}

/** The plan as compact text for the model. */
export function formatPlan(plan: Plan): string {
  const lines = [`${plan.target} x${plan.count} — about ${Math.round(plan.seconds)} s`]
  if (plan.steps.length === 0) return `${lines[0]}\nyou already have it`
  if (Object.keys(plan.have).length > 0) lines.push(`have: ${list(plan.have)}`)
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${describeStep(step)}`))
  for (const note of plan.notes) lines.push(`tip: ${note}`)
  lines.push(`raw needs: ${list(plan.raw) || 'nothing to gather'}`)
  return lines.join('\n')
}
