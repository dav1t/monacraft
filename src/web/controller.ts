import type { AgentEvent } from '../agent/agent.ts'
import type { ConnectOptions } from '../bot/connect.ts'
import type { Repos } from '../db/repos.ts'
import { errorMessage } from '../lib/text.ts'
import { createProvider, SwitchableProvider } from '../llm/providers.ts'
import { FatalLLMError } from '../llm/types.ts'
import { startSession, type Session } from '../session.ts'
import { activeLLM, applyPatch, publicSettings, saveSettings, type PanelSettings, type SettingsPatch } from './settings.ts'
import type { BrainStatus, ConnectionStatus, DbTable, LogEntry, MindStep, PanelEvent, Snapshot, Status } from './protocol.ts'
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
}

/** Owns the bot session for the web panel and turns everything that happens into events for connected browsers. */
export class Controller {
  readonly repos: Repos
  readonly #settingsPath: string
  readonly #print: (line: string) => void
  readonly #provider: SwitchableProvider
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

  constructor({ repos, settings, settingsPath, print = () => {} }: ControllerOptions) {
    this.repos = repos
    this.#settings = settings
    this.#settingsPath = settingsPath
    this.#print = print
    this.#provider = new SwitchableProvider(createProvider(activeLLM(settings)))
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

  status(): Status {
    const { host, port, username } = this.#settings.minecraft
    return {
      connection: this.#connection,
      brain: this.#brain,
      error: this.#error,
      server: `${host}:${port}`,
      username: this.#session?.bot.username ?? username,
      provider: this.#provider.name,
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
    this.#setStatus('connecting')
    let session: Session
    try {
      session = await startSession({
        minecraft,
        provider: this.#provider,
        repos: this.repos,
        log: (line) => this.log(line),
        // A decision in flight when the session ends must not touch the (offline) status.
        onAgentEvent: (event) => {
          if (this.#session === session) this.#onAgentEvent(event)
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
      this.#provider.set(createProvider(activeLLM(this.#settings)))
      this.log(`🧠 brain switched to ${this.#provider.name}`)
      this.#emitStatus()
    }
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
    this.#setStatus('offline')
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
      case 'decision':
        if (!step) return
        step.decision = event.decision
        this.#setBrain('acting')
        this.#emit({ type: 'step', data: step })
        return
      case 'outcome':
        if (!step) return
        step.outcome = event.outcome
        this.#setBrain('idle')
        this.#emit({ type: 'step', data: step })
        // Tools may have written memory or skills; history always grows.
        this.changed('history')
        if (['remember', 'forget', 'set_goal'].includes(event.tool)) this.changed('memory')
        if (['create_skill', 'revise_skill', 'run_skill'].includes(event.tool)) this.changed('skills')
        return
      case 'invalid':
        if (!step) return
        step.invalid = event.error
        this.#setBrain('idle')
        this.#emit({ type: 'step', data: step })
        return
    }
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
