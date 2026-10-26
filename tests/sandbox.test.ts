import { describe, expect, it } from 'vitest'
import { compileSkill, runSkillCode, type SkillRuntime } from '../src/skills/sandbox.ts'

function runtime(signal = new AbortController().signal) {
  const calls: Array<[string, unknown]> = []
  const rt: SkillRuntime = {
    call: async (tool, args) => {
      calls.push([tool, args])
      return `${tool} ok`
    },
    log: () => {},
    signal,
  }
  return { rt, calls }
}

describe('compileSkill', () => {
  it('accepts valid bodies and rejects syntax errors', () => {
    expect(() => compileSkill('await tools.say({ message: "hi" })')).not.toThrow()
    expect(() => compileSkill('await tools.say({')).toThrow(SyntaxError)
  })
})

describe('runSkillCode', () => {
  it('calls tools, passes args and reports return value and logs', async () => {
    const { rt, calls } = runtime()
    const code = 'const r = await tools.mine({ block_type: args.block }); log("did it"); return r'
    expect(await runSkillCode(code, { block: 'stone' }, rt)).toBe('skill returned "mine ok"; log: did it')
    expect(calls).toEqual([['mine', { block_type: 'stone' }]])
  })

  it('has no access to Node globals or eval', async () => {
    const { rt } = runtime()
    expect(await runSkillCode('return typeof require + typeof process + typeof fetch', {}, rt)).toBe('skill returned "undefinedundefinedundefined"')
    await expect(runSkillCode('return eval("1 + 1")', {}, rt)).rejects.toThrow(/Code generation from strings disallowed/)
  })

  it('stops synchronous infinite loops', async () => {
    const { rt } = runtime()
    await expect(runSkillCode('while (true) {}', {}, rt)).rejects.toThrow(/timed out/)
  })

  it('rejects when the signal aborts', async () => {
    const controller = new AbortController()
    const { rt } = runtime(controller.signal)
    const running = runSkillCode('await new Promise(() => {})', {}, rt)
    controller.abort(new Error('player interrupted'))
    await expect(running).rejects.toThrow('player interrupted')
  })

  it('does not let skills create or revise skills', async () => {
    const { rt } = runtime()
    await expect(runSkillCode('await tools.create_skill({})', {}, rt)).rejects.toThrow(/cannot be used inside a skill/)
    await expect(runSkillCode('await tools.run_skill({ name: "x" })', {}, rt)).rejects.toThrow(/cannot be used inside a skill/)
  })
})
