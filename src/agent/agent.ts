import { setTimeout as sleep } from 'node:timers/promises'
import type { Repos } from '../db/repos.ts'
import { Mutex } from '../lib/mutex.ts'
import { errorMessage, truncate } from '../lib/text.ts'
import { FatalLLMError, LLMFormatError, type Decision, type LLMProvider, type StreamDelta } from '../llm/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { BaseContext } from '../tools/types.ts'
import { buildUserPrompt } from './prompt.ts'

/** Abort reason for actions stopped on purpose (chat, reflex, time limit, shutdown). */
export class Interrupt extends Error {
  override name = 'Interrupt'
}

/** What the agent is doing, step by step, for live displays. */
export type AgentEvent =
  | { type: 'deciding' }
  | { type: 'stream'; delta: StreamDelta }
  | { type: 'decision'; decision: Decision }
  | { type: 'outcome'; tool: string; outcome: string }
  | { type: 'invalid'; error: string }

export interface AgentOptions {
  provider: LLMProvider
  registry: ToolRegistry
  repos: Repos
  systemPrompt: string
  /** Current world snapshot, embedded in every prompt. */
  observe: () => unknown
  context: Omit<BaseContext, 'signal'>
  log?: (line: string) => void
  actionTimeoutMs?: number
  historyWindow?: number
  onEvent?: (event: AgentEvent) => void
}

export class Agent {
  readonly #options: Required<AgentOptions>
  readonly #mutex = new Mutex()
  #unreadChat: string[] = []
  #action: AbortController | null = null
  #running = false
  #stopped = false
  #reflexRan = false

  constructor(options: AgentOptions) {
    this.#options = { log: console.log, actionTimeoutMs: 90_000, historyWindow: 15, onEvent: () => {}, ...options }
  }

  onChat(username: string, message: string): void {
    this.#unreadChat.push(`<${username}> ${message}`)
    this.interrupt(`${username} said something`)
  }

  /** Abort the running action, if any. */
  interrupt(reason: string): void {
    this.#action?.abort(new Interrupt(reason))
  }

  /** Abort the running action and run `fn` before the agent's next action (used by reflexes). */
  exclusive<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    this.interrupt(reason)
    return this.#mutex.run(async () => {
      this.#reflexRan = true
      return fn()
    })
  }

  async step(): Promise<void> {
    const { provider, registry, repos, log, systemPrompt, onEvent } = this.#options
    this.#reflexRan = false
    const chat = [...this.#unreadChat]
    const user = buildUserPrompt({
      snapshot: this.#options.observe(),
      ...splitGoal(repos.memory.all()),
      skills: repos.skills.list(),
      history: repos.history.recent(this.#options.historyWindow),
      chat,
      revelations: repos.revelations.list().map((r) => r.content),
    })
    this.#unreadChat.splice(0, chat.length)
    let decision: Decision
    onEvent({ type: 'deciding' })
    try {
      decision = await provider.decide({
        system: systemPrompt,
        user,
        tools: registry.specs(),
        onStream: (delta) => onEvent({ type: 'stream', delta }),
      })
    } catch (err) {
      // Keep the chat unanswered so the next prompt still shows it.
      this.#unreadChat.unshift(...chat)
      if (!(err instanceof LLMFormatError)) throw err
      log(`⚠ ${err.message}`)
      onEvent({ type: 'invalid', error: err.message })
      repos.history.add('event', `your last reply was invalid (${errorMessage(err)}); reply with exactly one tool call`)
      return
    }

    for (const line of chat) repos.history.add('chat', line)
    log(`💭 ${decision.thought || '…'}\n   → ${decision.tool} ${JSON.stringify(decision.args)}`)
    onEvent({ type: 'decision', decision })
    const outcome = await this.#mutex.run(() => this.#execute(decision))
    log(`   ${truncate(outcome, 300)}`)
    onEvent({ type: 'outcome', tool: decision.tool, outcome })
    repos.history.add('action', formatAction(decision, outcome))
  }

  async run(): Promise<void> {
    this.#running = true
    while (this.#running) {
      const started = Date.now()
      try {
        await this.step()
      } catch (err) {
        if (err instanceof FatalLLMError) throw err
        this.#options.log(`⚠ step failed: ${errorMessage(err)} — retrying in 5s`)
        await sleep(5_000)
      }
      const elapsed = Date.now() - started
      if (elapsed < 1_000) await sleep(1_000 - elapsed)
    }
  }

  stop(): void {
    this.#running = false
    this.#stopped = true
    this.interrupt('shutting down')
  }

  async #execute({ tool, args }: Decision): Promise<string> {
    if (this.#stopped) return 'skipped: shutting down'
    if (this.#unreadChat.length > 0) return 'skipped: a player spoke before the action started'
    if (this.#reflexRan) return 'skipped: a reflex ran while you were deciding'
    const controller = new AbortController()
    const limit = this.#options.registry.get(tool)?.timeoutMs ?? this.#options.actionTimeoutMs
    const timer = setTimeout(() => controller.abort(new Interrupt(`time limit of ${limit / 1000}s reached`)), limit)
    this.#action = controller
    // A tool that ignores its signal is cut off here. It may keep running in the background.
    let onAbort: () => void = () => {}
    const cutOff = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([
        this.#options.registry.run(tool, args, { ...this.#options.context, signal: controller.signal }),
        cutOff,
      ])
      return `ok: ${result}`
    } catch (err) {
      if (controller.signal.aborted) return `interrupted: ${errorMessage(controller.signal.reason)}`
      return `error: ${errorMessage(err)}`
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      this.#action = null
    }
  }
}

function splitGoal(memory: Record<string, string>): { goal: string | null; memory: Record<string, string> } {
  const { goal, ...rest } = memory
  return { goal: goal ?? null, memory: rest }
}

function formatAction({ thought, tool, args }: Decision, outcome: string): string {
  const why = thought ? `(${truncate(thought, 160)}) ` : ''
  return truncate(`${why}${tool} ${JSON.stringify(args)} → ${outcome}`, 600)
}
