// Live panel state, fed by the server's event stream.
import type {
  DbTable,
  GoalsView,
  LogEntry,
  MemoryEntry,
  MindStep,
  PanelEvents,
  PlayerState,
  PublicSettings,
  Status,
} from '../../../src/web/protocol.ts'
import { api } from './api.ts'

const MAX_LOGS = 1500
const MAX_STEPS = 60

class Panel {
  status = $state<Status | null>(null)
  settings = $state<PublicSettings | null>(null)
  logs = $state<LogEntry[]>([])
  steps = $state<MindStep[]>([])
  player = $state<PlayerState | null>(null)
  memory = $state<MemoryEntry[]>([])
  /** The goal tree, kept here because it shows on several tabs. */
  goals = $state<GoalsView>({ tree: null, past: [] })
  streamLost = $state(false)
  /** Bumped when a table changes; views that show the table reload on change. */
  versions = $state<Record<DbTable, number>>({
    memory: 0,
    skills: 0,
    history: 0,
    revelations: 0,
    goals: 0,
    days: 0,
    lessons: 0,
    templates: 0,
    structures: 0,
  })

  connect(): void {
    const events = new EventSource('/api/events')
    events.addEventListener('open', () => (this.streamLost = false))
    events.addEventListener('error', () => (this.streamLost = true))
    const on = <K extends keyof PanelEvents>(type: K, handle: (data: PanelEvents[K]) => void): void =>
      events.addEventListener(type, (e) => handle(JSON.parse((e as MessageEvent<string>).data) as PanelEvents[K]))

    on('snapshot', (snap) => {
      this.status = snap.status
      this.settings = snap.settings
      this.player = snap.state
      this.logs = snap.logs
      this.steps = snap.steps
      // Something may have changed while the stream was down.
      for (const table of Object.keys(this.versions) as DbTable[]) this.versions[table]++
      this.loadMemory()
      this.loadGoals()
    })
    on('status', (status) => {
      this.status = status
      if (status.connection !== 'online') this.player = null
    })
    on('settings', (settings) => (this.settings = settings))
    on('state', (state) => (this.player = state))
    on('log', (entry) => {
      this.logs.push(entry)
      if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    })
    on('step', (step) => {
      const index = this.steps.findLastIndex((s) => s.id === step.id)
      if (index === -1) {
        this.steps.push(step)
        if (this.steps.length > MAX_STEPS) this.steps.shift()
      } else this.steps[index] = step
    })
    on('delta', ({ id, kind, text }) => {
      const step = this.steps.findLast((s) => s.id === id)
      if (step) step[kind === 'thinking' ? 'thinking' : kind === 'text' ? 'text' : 'tool'] += text
    })
    on('db', ({ table }) => {
      this.versions[table]++
      if (table === 'memory') this.loadMemory()
      if (table === 'goals') this.loadGoals()
    })
  }

  loadMemory(): void {
    api<MemoryEntry[]>('GET', '/api/memory').then((memory) => (this.memory = memory), () => {})
  }

  loadGoals(): void {
    api<GoalsView>('GET', '/api/goals').then((goals) => (this.goals = goals), () => {})
  }
}

export const panel = new Panel()
