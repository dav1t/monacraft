import { createSkill, reviseSkill, runSkill } from '../skills/tools.ts'
import { place } from './building.ts'
import { say, wait } from './chat.ts'
import { attack } from './combat.ts'
import { craft, smelt } from './crafting.ts'
import { collectDrops, eat, equip } from './inventory.ts'
import { forget, remember, setGoal } from './memory.ts'
import { breakBlock, mine } from './mining.ts'
import { explore, goTo, goToPlayer } from './movement.ts'
import { findBlocks, findEntities, lookAt, scanBlocks } from './sensing.ts'
import type { Tool } from './types.ts'

export const allTools: Tool[] = [
  say, wait,
  goTo, goToPlayer, explore,
  mine, breakBlock, collectDrops, craft, smelt, place,
  attack, eat, equip,
  scanBlocks, findBlocks, findEntities, lookAt,
  remember, forget, setGoal,
  createSkill, runSkill, reviseSkill,
]
