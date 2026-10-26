import { z } from 'zod'
import { errorMessage } from '../lib/text.ts'
import { defineTool, ToolError } from '../tools/types.ts'
import { compileSkill, runSkillCode } from './sandbox.ts'

const skillName = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, 'use snake_case, 3-40 characters')

function checkSyntax(code: string): void {
  try {
    compileSkill(code)
  } catch (err) {
    throw new ToolError(`syntax error: ${errorMessage(err)}`)
  }
}

export const createSkill = defineTool({
  name: 'create_skill',
  description: 'Save a reusable multi-step routine as JavaScript (see "Skills" in your instructions).',
  schema: z.object({ name: skillName, description: z.string().min(1), code: z.string().min(1) }),
  run: async ({ name, description, code }, { repos }) => {
    if (repos.skills.get(name)) throw new ToolError(`skill ${name} already exists; use revise_skill to change it`)
    checkSyntax(code)
    repos.skills.create({ name, description, code })
    return `saved skill ${name}`
  },
})

export const reviseSkill = defineTool({
  name: 'revise_skill',
  description: 'Replace the code (and optionally the description) of a saved skill.',
  schema: z.object({ name: skillName, code: z.string().min(1), description: z.string().min(1).optional() }),
  run: async ({ name, code, description }, { repos }) => {
    if (!repos.skills.get(name)) throw new ToolError(`no skill named ${name}`)
    checkSyntax(code)
    repos.skills.update(name, { code, description })
    return `revised skill ${name}`
  },
})

export const runSkill = defineTool({
  name: 'run_skill',
  description: 'Run a saved skill, optionally with arguments.',
  schema: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).default({}) }),
  timeoutMs: 300_000,
  run: async ({ name, args }, { repos, call, log, signal }) => {
    const skill = repos.skills.get(name)
    if (!skill) throw new ToolError(`no skill named ${name}`)
    try {
      const result = await runSkillCode(skill.code, args, { call, log, signal })
      repos.skills.recordResult(name, true)
      return result
    } catch (err) {
      if (signal.aborted) throw err
      repos.skills.recordResult(name, false)
      throw new ToolError(`skill ${name} failed: ${errorMessage(err)}`)
    }
  },
})
