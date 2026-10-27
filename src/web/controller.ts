import type { Bot } from 'mineflayer'
import type { AgentEvent } from '../agent/agent.ts'
import { GoalKeeper } from '../agent/goals.ts'
import type { ConnectOptions } from '../bot/connect.ts'
import type { ModelStats, Repos } from '../db/repos.ts'
import { errorMessage } from '../lib/text.ts'
import { listModels, type ModelInfo } from '../llm/models.ts'
import { createProvider, labelOf, SwitchableProvider, type CallRecord, type LLMSettings, type ProviderId } from '../llm/providers.ts'
import { FatalLLMError, type LLMProvider } from '../llm/types.ts'
import { botWorld } from '../planning/world.ts'
import { startSession, type Session, type SessionOptions } from '../session.ts'
import type { SleepEvent } from '../sleep.ts'
import { activeLLM, applyPatch, publicSettings, saveSettings, type PanelSettings, type SettingsPatch } from './settings.ts'
import type { BrainStatus, ConnectionStatus, DbTable, GoalsView, LogEntry, MindStep, ModelList, PanelEvent, Snapshot, Status } from './protocol.ts'
import { readPlayerState } from './state.ts'

const MAX_LOGS = 1000
const MAX_STEPS = 40
const STATE_INTERVAL_MS = 1000

export interface ControllerOptions {
  repos: Repos
  settings: PanelSettings
  settingsPath: string
  /** Also print log lines here (the terminal). */
  print?: (line: string) => void
  /** Replaceable in tests. */
  startSession?: (options: SessionOptions) => Promise<Session>
  createProvider?: (settings: LLMSettings) => LLMProvider
}

/** Owns the bot session for the web panel and turns everything that happens into events for connected browsers. */
export class Controller {
  readonly repos: Repos
  readonly #settingsPath: string
  readonly #print: (line: string) => void
  readonly #provider: SwitchableProvider
  readonly #startSession: (options: SessionOptions) => Promise<Session>
  readonly #createProvider: (settings: LLMSettings) => LLMProvider
  readonly #listeners = new Set<(event: PanelEvent) => void>()
  #settings: PanelSettings
  #session: Session | null = null
  #connection: ConnectionStatus = 'offline'
  #brain: BrainStatus = 'idle'
  #error: string | null = null
  #logs: LogEntry[] = []
  #steps: MindStep[] = []
  #nextId = 1
  #stateTimer: NodeJS.Timeout | null = null
  #promptTokens = 0
  #promptTokensEstimated = false
  #sleeping = false
  /** The current or last bot join; model calls are recorded under it. */
  #sessionId: number | null = null
  #sessionCost: number | null = null
  /** The last decision's usage row, marked when its tool call returns an error. */
  #lastDecisionRow: number | null = null
  /** Each provider's last model list, with the settings (minus the model) it was loaded with. */
  readonly #models = new Map<ProviderId, { key: string; list: Promise<ModelInfo[]> }>()

  constructor({ repos, settings, settingsPath, print = () => {}, ...overrides }: ControllerOptions) {
    this.repos = repos
    this.#settings = settings
    this.#settingsPath = settingsPath
    this.#print = print
    this.#startSession = overrides.startSession ?? startSession
    this.#createProvider = overrides.createProvider ?? createProvider
    const llm = activeLLM(settings)
    this.#provider = new SwitchableProvider(this.#createProvider(llm), labelOf(llm), (record) => this.#onCall(record))
  }

  subscribe(listener: (event: PanelEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Everything a freshly opened page needs. */
  snapshot(): Snapshot {
    return {
      status: this.status(),
      settings: publicSettings(this.#settings),
      logs: this.#logs,
      steps: this.#steps,
      state: this.#session ? readPlayerState(this.#session.bot) : null,
    }
  }

  /** The connected bot, for the POV viewer. */
  currentBot(): Bot | null {
    return this.#connection === 'online' ? (this.#session?.bot ?? null) : null
  }

  status(): Status {
    const { host, port, username } = this.#settings.minecraft
    return {
      connection: this.#connection,
      brain: this.#brain,
      error: this.#error,
      server: `${host}:${port}`,
      username: this.#session?.bot.username ?? username,
      provider: this.#provider.name,
      model: this.#provider.label.model,
      sessionCost: this.#sessionCost,
      promptTokens: this.#promptTokens,
      promptTokensEstimated: this.#promptTokensEstimated,
      contextTokens: this.#provider.contextWindow ?? null,
    }
  }

  log(text: string): void {
    this.#print(`[${new Date().toLocaleTimeString()}] ${text}`)
    const entry: LogEntry = { id: this.#nextId++, time: Date.now(), text }
    this.#logs.push(entry)
    if (this.#logs.length > MAX_LOGS) this.#logs.splice(0, this.#logs.length - MAX_LOGS)
    this.#emit({ type: 'log', data: entry })
  }

  async connect(minecraft: ConnectOptions): Promise<void> {
    if (this.#connection !== 'offline') throw new Error('already connected — disconnect first')
    this.#updateSettings({ minecraft })
    this.#error = null
    this.#sessionId = Date.now()
    this.#sessionCost = null
    this.#lastDecisionRow = null
    this.#setStatus('connecting')
    let session: Session
    try {
      session = await this.#startSession({
        minecraft,
        provider: this.#provider,
        repos: this.repos,
        log: (line) => this.log(line),
        // A decision in flight when the session ends must not touch the (offline) status.
        onAgentEvent: (event) => {
          if (this.#session === session) this.#onAgentEvent(event)
        },
        onSleepEvent: (event) => {
          if (this.#session === session) this.#onSleepEvent(event)
        },
        onEnd: (reason) => this.#onEnded(session, `disconnected: ${reason}`),
      })
    } catch (err) {
      this.#error = errorMessage(err)
      this.log(`⚠ ${this.#error}`)
      this.#setStatus('offline')
      throw err
    }
    this.#session = session
    this.#brain = 'idle'
    this.#setStatus('online')
    this.#stateTimer = setInterval(() => this.#emitState(), STATE_INTERVAL_MS)
    void this.#runAgent(session)
  }

  disconnect(): void {
    const session = this.#session
    if (!session) return
    this.log('disconnecting')
    session.stop()
    this.#onEnded(session, null)
  }

  updateSettings(patch: SettingsPatch): void {
    const before = JSON.stringify(activeLLM(this.#settings))
    this.#updateSettings(patch)
    if (JSON.stringify(activeLLM(this.#settings)) !== before) {
      const llm = activeLLM(this.#settings)
      this.#provider.set(this.#createProvider(llm), labelOf(llm))
      this.log(`🧠 brain switched to ${this.#provider.name}`)
      this.#emitStatus()
    }
  }

  /** A provider's models (the active one's by default), loaded once per provider setup unless `refresh` is set. */
  async models(refresh = false, provider: ProviderId = this.#settings.active): Promise<ModelList> {
    const llm = this.#settings.providers[provider]
    // Picking another model must not reload the list.
    const key = JSON.stringify({ ...llm, model: '' })
    let entry = this.#models.get(provider)
    if (refresh || entry?.key !== key) {
      entry = { key, list: listModels(llm) }
      this.#models.set(provider, entry)
    }
    try {
      return { provider, current: llm.model, models: await entry.list }
    } catch (err) {
      // A failed list is tried again next time.
      if (this.#models.get(provider) === entry) this.#models.delete(provider)
      return { provider, current: llm.model, models: null, error: errorMessage(err) }
    }
  }

  /** Per-model stats for the current (or last) session and for all time. */
  stats(): { session: ModelStats[]; allTime: ModelStats[] } {
    return { session: this.#sessionId === null ? [] : this.repos.usage.stats(this.#sessionId), allTime: this.repos.usage.stats() }
  }

  addRevelation(content: string) {
    const revelation = this.repos.revelations.add(content)
    this.repos.history.add('event', `a revelation arrived from your creator: ${content}`)
    this.log(`✨ revelation: ${content}`)
    // Make the agent reconsider right away instead of after the current action.
    this.#session?.agent.interrupt('a revelation arrived')
    this.#emit({ type: 'db', data: { table: 'revelations' } })
    return revelation
  }

  /** The goal tree service; it can plan only while the bot is online. */
  goals(): GoalKeeper {
    return new GoalKeeper(this.repos, this.#session ? botWorld(this.#session.bot) : null)
  }

  goalsView(): GoalsView {
    return { tree: this.goals().tree(), past: this.repos.goals.past(5) }
  }

  /** A goal set by the player: recorded in the history, and the agent reconsiders right away. */
  setGoal(title: string): GoalsView {
    const result = this.goals().setGoal(title)
    this.repos.history.add('event', `your creator set your goal: ${title}`)
    this.log(`🎯 ${result}`)
    this.#session?.agent.interrupt('your creator set a new goal')
    this.changed('goals')
    this.changed('history')
    return this.goalsView()
  }

  /** Consolidate now, without waiting for night. */
  async nap(): Promise<void> {
    if (!this.#session) throw new Error('the bot is offline')
    await this.#session.sleep.run('nap')
  }

  changed(table: DbTable): void {
    this.#emit({ type: 'db', data: { table } })
  }

  #updateSettings(patch: SettingsPatch): void {
    this.#settings = applyPatch(this.#settings, patch)
    try {
      saveSettings(this.#settingsPath, this.#settings)
    } catch (err) {
      this.log(`⚠ could not save settings: ${errorMessage(err)}`)
    }
    this.#emit({ type: 'settings', data: publicSettings(this.#settings) })
  }

  /** Runs the agent until the session ends. A broken brain (bad key, model without tools) waits for new brain settings. */
  async #runAgent(session: Session): Promise<void> {
    while (this.#session === session) {
      try {
        await session.agent.run()
        return
      } catch (err) {
        if (this.#session !== session) return
        if (!(err instanceof FatalLLMError)) {
          this.log(`⚠ agent stopped: ${errorMessage(err)}`)
          return
        }
        this.log(`⚠ brain paused: ${err.message} — change the brain settings to resume`)
        this.#brain = 'paused'
        this.#emitStatus()
        await this.#provider.changed()
        this.log('🧠 brain resumed')
      }
    }
  }

  #onEnded(session: Session, reason: string | null): void {
    if (this.#session !== session) return
    this.#session = null
    if (this.#stateTimer) clearInterval(this.#stateTimer)
    this.#stateTimer = null
    this.#error = reason
    this.#brain = 'idle'
    this.#sleeping = false
    this.#setStatus('offline')
  }

  /** A model call finished; an in-flight call that ends after a disconnect still belongs to that session. */
  #onCall(record: CallRecord): void {
    if (this.#sessionId === null) return
    let id: number
    try {
      id = this.repos.usage.record(this.#sessionId, record)
    } catch (err) {
      // A later tool error must not land on an older decision.
      if (record.kind === 'decision') this.#lastDecisionRow = null
      this.log(`⚠ could not record usage: ${errorMessage(err)}`)
      return
    }
    const { cost, inputTokens, outputTokens } = record.usage
    if (cost !== undefined) this.#sessionCost = (this.#sessionCost ?? 0) + cost
    const step = this.#steps.at(-1)
    if (record.kind === 'decision') {
      this.#lastDecisionRow = id
      if (step && step.model === undefined) {
        Object.assign(step, {
          model: record.model,
          ...(cost !== undefined && { cost }),
          ...(inputTokens !== undefined && { inputTokens }),
          ...(outputTokens !== undefined && { outputTokens }),
        })
        this.#emit({ type: 'step', data: step })
      }
    }
    this.#emitStatus()
    this.changed('llm_calls')
  }

  #onAgentEvent(event: AgentEvent): void {
    const step = this.#steps.at(-1)
    switch (event.type) {
      case 'deciding': {
        const next: MindStep = { id: this.#nextId++, startedAt: Date.now(), thinking: '', text: '', tool: '' }
        this.#steps.push(next)
        if (this.#steps.length > MAX_STEPS) this.#steps.shift()
        this.#setBrain('deciding')
        this.#emit({ type: 'step', data: next })
        return
      }
      case 'stream':
        if (!step) return
        step[event.delta.kind === 'thinking' ? 'thinking' : event.delta.kind === 'text' ? 'text' : 'tool'] += event.delta.text
        this.#emit({ type: 'delta', data: { id: step.id, ...event.delta } })
        return
      case 'usage':
        this.#promptTokens = event.promptTokens
        this.#promptTokensEstimated = event.estimated
        if (step) step.promptTokens = event.promptTokens
        this.#emitStatus()
        return
      case 'decision':
        if (!step) return
        step.decision = event.decision
        this.#setBrain('acting')
        this.#emit({ type: 'step', data: step })
        return
      case 'outcome':
        if (event.outcome.startsWith('error:') && this.#lastDecisionRow !== null) {
          try {
            this.repos.usage.markToolError(this.#lastDecisionRow)
          } catch (err) {
            this.log(`⚠ could not record usage: ${errorMessage(err)}`)
          }
        }
        if (!step) return
        step.outcome = event.outcome
        this.#setBrain('idle')
        this.#emit({ type: 'step', data: step })
        // Tools may have written memory or skills; history always grows.
        this.changed('history')
        // Goal bookkeeping runs after every action.
        this.changed('goals')
        if (['remember', 'forget'].includes(event.tool)) this.changed('memory')
        if (event.tool === 'build') this.changed('structures')
        if (['create_skill', 'revise_skill', 'run_skill'].includes(event.tool)) this.changed('skills')
        return
      case 'invalid':
        if (!step) return
        step.invalid = event.error
        this.#setBrain('idle')
        this.#emit({ type: 'step', data: step })
        return
      case 'interrupted':
        if (!step) return
        step.outcome = `interrupted: ${event.reason}`
        this.#setBrain('idle')
        this.#emit({ type: 'step', data: step })
        return
    }
  }

  #onSleepEvent(event: SleepEvent): void {
    if (event.type === 'start') {
      this.#sleeping = true
      this.#brain = 'sleeping'
      this.#emitStatus()
      return
    }
    this.#sleeping = false
    this.#brain = 'idle'
    this.#emitStatus()
    for (const table of ['days', 'lessons', 'memory', 'goals', 'history', 'templates'] as const) this.changed(table)
  }

  #emitState(): void {
    if (!this.#session) return
    try {
      this.#emit({ type: 'state', data: readPlayerState(this.#session.bot) })
    } catch {
      // The bot can be mid-respawn with no entity; the next tick will do.
    }
  }

  #setBrain(brain: BrainStatus): void {
    if (this.#brain === 'paused' && brain !== 'deciding') return
    // An action that was running when sleep began still reports back; the bot stays asleep.
    if (this.#sleeping) return
    this.#brain = brain
    this.#emitStatus()
  }

  #setStatus(connection: ConnectionStatus): void {
    this.#connection = connection
    this.#emitStatus()
  }

  #emitStatus(): void {
    this.#emit({ type: 'status', data: this.status() })
  }

  #emit(event: PanelEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
