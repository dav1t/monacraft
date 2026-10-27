import { describe, expect, it } from 'vitest'
import { parseDecisionText } from '../src/llm/parse.ts'

const names = ['mine', 'craft', 'sleep', 'say', 'plan_goal', 'place']

describe('parseDecisionText', () => {
  it('reads a JSON decision', () => {
    expect(parseDecisionText('{"thought":"hi","tool":"say","args":{"message":"yo"}}', names)).toEqual({ thought: 'hi', tool: 'say', args: { message: 'yo' } })
  })

  // Gemini models often write the call as Python instead of using the tool-call channel.
  it('reads a Python-style call wrapped in tool_code and print(default_api…)', () => {
    expect(parseDecisionText("tool_code\nprint(default_api.mine(block_type='oak_log', count=3))\n", names)).toEqual({
      thought: '',
      tool: 'mine',
      args: { block_type: 'oak_log', count: 3 },
    })
    expect(parseDecisionText('tool_code\nprint(default_api.sleep())\n', names)).toEqual({ thought: '', tool: 'sleep', args: {} })
  })

  it('reads lists, double quotes, escapes, booleans and negative numbers', () => {
    expect(parseDecisionText("print(default_api.plan_goal(subgoals=['find sheep', 'craft bed']))", names)?.args).toEqual({ subgoals: ['find sheep', 'craft bed'] })
    expect(parseDecisionText('default_api.say(message="I\'ll try, \\"ok\\"")', names)?.args).toEqual({ message: 'I\'ll try, "ok"' })
    expect(parseDecisionText('place(block_type="crafting_table", x=-16, y=73, z=-641.5, force=True, note=None)', names)?.args).toEqual({
      block_type: 'crafting_table',
      x: -16,
      y: 73,
      z: -641.5,
      force: true,
      note: null,
    })
  })

  it('reads a call with a JSON object argument', () => {
    expect(parseDecisionText('craft({"item":"crafting_table","count":1})\n', names)).toEqual({ thought: '', tool: 'craft', args: { item: 'crafting_table', count: 1 } })
  })

  it('ignores unknown names, prose and broken calls', () => {
    expect(parseDecisionText('print(default_api.fly(height=3))', names)).toBeNull()
    expect(parseDecisionText('I should mine some logs next.', names)).toBeNull()
    expect(parseDecisionText("mine(block_type='oak_log', count=", names)).toBeNull()
    expect(parseDecisionText('mine(oak_log)', names)).toBeNull()
  })
})
