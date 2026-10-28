import { setTimeout as sleep } from 'node:timers/promises'
import type { Repos } from '../db/repos.ts'
import { describeContainer } from '../db/containers.ts'
import { describeScar } from '../db/identity.ts'
import { describeStructure } from '../db/structures.ts'
import { Mutex } from '../lib/mutex.ts'
import { errorMessage, truncate } from '../lib/text.ts'
import { FatalLLMError, LLMFormatError, type Conversation, type Decision, type LLMProvider, type StreamDelta, type ToolOutcome } from '../llm/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { BaseContext } from '../tools/types.ts'
import { GoalKeeper } from './goals.ts'
import { buildUpdate, buildUserPrompt, CAPS } from './prompt.ts'

/** A conversation is replaced by a fresh full prompt once the model reads this many tokens per step. */
export const CONVERSATION_TOKENS = 120_000

/** Abort reason for actions stopped on purpose (chat, reflex, time limit, shutdown). */
export class Interrupt extends Error {
  override name = 'Interrupt'
}

/** What the agent is doing, step by step, for live displays. */
export type AgentEvent =
  | { type: 'deciding'; promptChars: number }
  | { type: 'stream'; delta: StreamDelta }
  | { type: 'decision'; decision: Decision }
  /** Tokens the model read for the last decision; estimated when the provider does not report them. */
  | { type: 'usage'; promptTokens: number; estimated: boolean }
  | { type: 'outcome'; tool: string; outcome: string }
  | { type: 'invalid'; error: string }
  /** Thinking was cut short by something that happened meanwhile; the next step decides with the news. */
  | { type: 'interrupted'; reason: string }

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
  /** Goal tree bookkeeping; defaults to one without a world (nothing is planned). */
  goals?: GoalKeeper
}

export class Agent {
  readonly #options: Required<AgentOptions>
  readonly #mutex = new Mutex()
  #unreadChat: string[] = []
  #action: AbortController | null = null
  /** Cancels the model call in flight, when the agent is thinking. */
  #thinking: AbortController | null = null
  #actionTool: string | null = null
  #running = false
  #stopped = false
  /** Cuts short the pause after a failed step when the agent stops. */
  readonly #stopping = new AbortController()
  #reflexRan = false
  #paused: { promise: Promise<void>; resume: () => void } | null = null
  #promptChars = 0
  /** The running conversation, for providers that keep one, with the provider and day it belongs to. */
  #conversation: { value: Conversation; provider: string; day: number } | null = null
  /** The last action's result, not yet sent to the conversation. */
  #result: ToolOutcome | null = null
  /** History up to this id is already known to the model, from its prompt or its conversation. */
  #seen = 0
  /** The goal section the model saw last; updates repeat it only when it changed. */
  #goalShown: string | null = null

  constructor(options: AgentOptions) {
    this.#options = {
      log: console.log,
      actionTimeoutMs: 90_000,
      historyWindow: CAPS.history,
      onEvent: () => {},
      goals: new GoalKeeper(options.repos),
      ...options,
    }
  }

  /** Length of the last prompt, in characters. */
  get promptChars(): number {
    return this.#promptChars
  }

  /** The tool whose action is running, if any. */
  get currentTool(): string | null {
    return this.#actionTool
  }

  get paused(): boolean {
    return this.#paused !== null
  }

  /** Stop starting new steps (the running action finishes). Reflexes keep working: they do not wait for the loop. */
  pause(): void {
    if (this.#paused) return
    let resume = () => {}
    const promise = new Promise<void>((resolve) => (resume = resolve))
    this.#paused = { promise, resume }
  }

  resume(): void {
    const paused = this.#paused
    this.#paused = null
    paused?.resume()
  }

  onChat(username: string, message: string): void {
    this.#unreadChat.push(`<${username}> ${message}`)
    this.interrupt(`${username} said something — answer, then pick this action up again if it still makes sense`)
  }

  /** Abort the running action, or the thinking about the next one, if any. */
  interrupt(reason: string): void {
    this.#action?.abort(new Interrupt(reason))
    this.#thinking?.abort(new Interrupt(reason))
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
    const { provider, registry, repos, log, systemPrompt, onEvent, goals } = this.#options
    this.#reflexRan = false
    const chat = [...this.#unreadChat]
    goals.refresh()
    const goal = repos.goals.active()
    const goalSection = goals.section()
    const day = repos.days.todayAfter()
    const conversation = this.#continuing(day)
    const known = repos.history.lastId()
    const user = conversation
      ? buildUpdate({
          snapshot: this.#options.observe(),
          goal: goalSection === this.#goalShown ? null : goalSection,
          // Its own actions are already in the conversation; everything else that happened is news.
          events: repos.history.recent(CAPS.history, Math.max(this.#seen, day)).filter((h) => h.kind !== 'action'),
          chat,
        })
      : buildUserPrompt({
          snapshot: this.#options.observe(),
          goal: goalSection,
          goalNote: goal ? null : goals.lastGoalNote(),
          memory: repos.memory.list(),
          skills: repos.skills.list(),
          focus: goals.focus(),
          history: repos.history.recent(this.#options.historyWindow, day),
          chat,
          revelations: repos.revelations.list().map((r) => r.content),
          journal: repos.days.latest()?.journal ?? null,
          identity: repos.identity.current() ?? null,
          scars: repos.scars.list().map(describeScar),
          lessons: repos.lessons.list().map((l) => l.content),
          structures: repos.structures.list().map(describeStructure),
          containers: repos.containers.list().map(describeContainer),
          templates: goal && goals.needsPlan() ? repos.templates.match('goal', goal.title, CAPS.templates) : [],
        })
    this.#unreadChat.splice(0, chat.length)
    this.#promptChars = user.length
    let decision: Decision
    onEvent({ type: 'deciding', promptChars: user.length })
    const onStream = (delta: StreamDelta) => onEvent({ type: 'stream', delta })
    const thinking = new AbortController()
    this.#thinking = thinking
    const { signal } = thinking
    try {
      if (provider.startConversation) {
        const current = conversation ?? this.#startConversation(provider, day)
        decision = await current.next({ user, ...(conversation && this.#result && { result: this.#result }), onStream, signal })
      } else {
        decision = await provider.decide({ system: systemPrompt, user, tools: registry.specs(), onStream, signal })
      }
    } catch (err) {
      // Keep the chat unanswered so the next prompt still shows it.
      this.#unreadChat.unshift(...chat)
      if (signal.aborted) {
        // Nothing of this turn is kept: the next one shows the same news (and the last result) plus what interrupted it.
        const reason = errorMessage(signal.reason)
        log(`✋ stopped thinking: ${reason}`)
        onEvent({ type: 'interrupted', reason })
        return
      }
      if (!(err instanceof LLMFormatError)) throw err
      // The conversation took this turn (and the result in it); news from now on comes after it.
      this.#result = null
      this.#seen = known
      this.#goalShown = goalSection
      log(`⚠ ${err.message}`)
      onEvent({ type: 'invalid', error: err.message })
      repos.history.add('event', `your last reply was invalid (${errorMessage(err)}); reply with exactly one tool call`)
      return
    } finally {
      this.#thinking = null
    }
    this.#result = null
    this.#goalShown = goalSection

    for (const line of chat) repos.history.add('chat', line)
    this.#seen = repos.history.lastId()
    const estimated = decision.promptTokens === undefined
    // About 4 characters per token, counting the tool definitions the model reads too.
    const promptTokens = decision.promptTokens ?? Math.round((systemPrompt.length + user.length + JSON.stringify(registry.specs()).length) / 4)
    onEvent({ type: 'usage', promptTokens, estimated })
    log(`💭 ${decision.thought || '…'} (prompt ${estimated ? '~' : ''}${promptTokens} tokens)\n   → ${decision.tool} ${JSON.stringify(decision.args)}`)
    onEvent({ type: 'decision', decision })
    // The reply can arrive just as an interrupt lands; it was decided without the news, so it does not run.
    const outcome = signal.aborted
      ? `skipped: ${errorMessage(signal.reason)} — it happened while you were deciding`
      : await this.#mutex.run(() => this.#execute(decision))
    log(`   ${truncate(outcome, 300)}`)
    onEvent({ type: 'outcome', tool: decision.tool, outcome })
    repos.history.add('action', formatAction(decision, outcome))
    this.#result = { outcome, isError: outcome.startsWith('error:') }
    try {
      goals.afterAction(decision.tool, decision.args, outcome)
    } catch (err) {
      log(`⚠ goal bookkeeping failed: ${errorMessage(err)}`)
    }
  }

  /**
   * The conversation to continue, or null when a new one should start: none yet, a new day (sleep or nap folded the
   * old one into the journal), another provider, a closed one, or one that grew too long to read every step.
   */
  #continuing(day: number): Conversation | null {
    const current = this.#conversation
    if (!current) return null
    const { value } = current
    if (value.closed || current.day !== day || current.provider !== this.#options.provider.name || value.contextTokens > CONVERSATION_TOKENS) {
      this.#conversation = null
      return null
    }
    return value
  }

  #startConversation(provider: LLMProvider, day: number): Conversation {
    const value = provider.startConversation!({ system: this.#options.systemPrompt, tools: this.#options.registry.specs() })
    this.#conversation = { value, provider: provider.name, day }
    return value
  }

  async run(): Promise<void> {
    this.#running = true
    let failures = 0
    while (this.#running) {
      while (this.#paused && this.#running) await this.#paused.promise
      if (!this.#running) return
      const started = Date.now()
      try {
        await this.step()
        failures = 0
      } catch (err) {
        if (err instanceof FatalLLMError) throw err
        // Rate limits and outages last a while; hammering the server only extends them.
        const pause = Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MAX_MS)
        failures++
        this.#options.log(`⚠ step failed: ${errorMessage(err)} — retrying in ${pause / 1000}s`)
        await sleep(pause, undefined, { signal: this.#stopping.signal }).catch(() => {})
      }
      const elapsed = Date.now() - started
      if (elapsed < 1_000) await sleep(1_000 - elapsed)
    }
  }

  stop(): void {
    this.#running = false
    this.#stopped = true
    this.#stopping.abort()
    this.interrupt('shutting down')
    this.resume()
  }

  async #execute({ tool, args }: Decision): Promise<string> {
    if (this.#stopped) return 'skipped: shutting down'
    if (this.#unreadChat.length > 0) return 'skipped: a player spoke before the action started'
    if (this.#reflexRan) return 'skipped: a reflex ran while you were deciding'
    const controller = new AbortController()
    const limit = this.#options.registry.get(tool)?.timeoutMs ?? this.#options.actionTimeoutMs
    const timer = setTimeout(() => controller.abort(new Interrupt(`time limit of ${limit / 1000}s reached`)), limit)
    this.#action = controller
    this.#actionTool = tool
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
      this.#actionTool = null
    }
  }
}

/** Pause after a failed step; it doubles with each failure in a row, up to the max. */
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 60_000

function formatAction({ thought, tool, args }: Decision, outcome: string): string {
  const why = thought ? `(${truncate(thought, 160)}) ` : ''
  return truncate(`${why}${tool} ${JSON.stringify(args)} → ${outcome}`, 600)
}
