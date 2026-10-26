import { createSkill, reviseSkill, runSkill } from '../skills/tools.ts'
import { build } from './build.ts'
import { place } from './building.ts'
import { say, wait } from './chat.ts'
import { attack } from './combat.ts'
import { craft, smelt } from './crafting.ts'
import { collectDrops, eat, equip } from './inventory.ts'
import { forget, remember } from './memory.ts'
import { breakBlock, mine } from './mining.ts'
import { explore, goTo, goToPlayer } from './movement.ts'
import { done, giveUp, planGoal, planItemTool, setGoal, setSteps, switchSubgoal } from './planning.ts'
import { recall } from './recall.ts'
import { sleep } from './sleep.ts'
import { lookInChest, store, take } from './storage.ts'
import { findBlocks, findEntities, lookAt, scanBlocks } from './sensing.ts'
import type { Tool } from './types.ts'

export const allTools: Tool[] = [
  say, wait, sleep,
  goTo, goToPlayer, explore,
  mine, breakBlock, collectDrops, craft, smelt, place, build,
  attack, eat, equip,
  store, take, lookInChest,
  scanBlocks, findBlocks, findEntities, lookAt,
  remember, forget, recall,
  planItemTool, setGoal, planGoal, switchSubgoal, setSteps, done, giveUp,
  createSkill, runSkill, reviseSkill,
]
