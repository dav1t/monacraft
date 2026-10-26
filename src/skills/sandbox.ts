import vm from 'node:vm'

/**
 * Runs LLM-written skill code. node:vm is NOT a security boundary: it keeps honest mistakes
 * (require, process, eval, sync infinite loops) out, which is enough for a local model's code.
 * Skill code can still reach the host `Function` constructor through the exposed objects (e.g.
 * `tools.constructor.constructor`), so a malicious model could escape. The 1 s timeout only covers
 * synchronous code, so an async busy loop (`while (true) await 0`) can starve the event loop and block aborts.
 */

const BLOCKED_TOOLS = new Set(['create_skill', 'revise_skill', 'run_skill'])
const SYNC_TIMEOUT_MS = 1000

export interface SkillRuntime {
  call: (tool: string, args: unknown) => Promise<string>
  log: (message: string) => void
  signal: AbortSignal
}

const wrap = (code: string): string => `(async () => {\n${code}\n})()`

/** Throws SyntaxError when the code doesn't parse. */
export function compileSkill(code: string): vm.Script {
  return new vm.Script(wrap(code), { filename: 'skill.js' })
}

export async function runSkillCode(code: string, args: Record<string, unknown>, rt: SkillRuntime): Promise<string> {
  const notes: string[] = []
  const tools = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined
        return async (toolArgs: unknown = {}) => {
          if (BLOCKED_TOOLS.has(name)) throw new Error(`${name} cannot be used inside a skill`)
          rt.signal.throwIfAborted()
          return rt.call(name, toolArgs)
        }
      },
    },
  )
  const log = (message: unknown): void => {
    notes.push(String(message))
    rt.log(`[skill] ${String(message)}`)
  }
  const context = vm.createContext({ tools, args: structuredClone(args), log }, { codeGeneration: { strings: false, wasm: false } })

  rt.signal.throwIfAborted()
  // The timeout covers the synchronous part, up to the first await.
  const running = compileSkill(code).runInContext(context, { timeout: SYNC_TIMEOUT_MS }) as Promise<unknown>
  const result = await untilAborted(running, rt.signal)

  const parts = [result === undefined ? 'skill finished' : `skill returned ${JSON.stringify(result)}`]
  if (notes.length > 0) parts.push(`log: ${notes.slice(-5).join(' | ')}`)
  return parts.join('; ')
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
