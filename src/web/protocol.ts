// Types shared by the panel server and the Svelte UI. Keep this file free of runtime imports.
import type { ConnectOptions } from '../bot/connect.ts'
import type { HistoryEntry, Revelation, Skill } from '../db/repos.ts'
import type { AnthropicSettings, OllamaSettings, OpenAISettings, ProviderId } from '../llm/providers.ts'
import type { Decision, StreamDelta } from '../llm/types.ts'
import type { PlayerState, SlotItem } from './state.ts'

export type { Decision, HistoryEntry, PlayerState, ProviderId, Revelation, Skill, SlotItem, StreamDelta }

export type ConnectionStatus = 'offline' | 'connecting' | 'online'
export type BrainStatus = 'idle' | 'deciding' | 'acting' | 'paused'

export interface Status {
  connection: ConnectionStatus
  brain: BrainStatus
  error: string | null
  server: string
  username: string
  provider: string
}

export interface LogEntry {
  id: number
  time: number
  text: string
}

/** One decision of the agent as the panel shows it: streamed reasoning, the chosen tool, and how it went. */
export interface MindStep {
  id: number
  startedAt: number
  thinking: string
  text: string
  tool: string
  decision?: Decision
  outcome?: string
  invalid?: string
}

/** Settings as the browser sees them: API keys blanked, with a flag saying whether one is stored. */
export interface PublicSettings {
  minecraft: ConnectOptions
  active: ProviderId
  providers: {
    ollama: OllamaSettings
    openai: OpenAISettings & { hasApiKey: boolean }
    anthropic: AnthropicSettings & { hasApiKey: boolean }
  }
}

export type DbTable = 'memory' | 'skills' | 'history' | 'revelations'

export interface Snapshot {
  status: Status
  settings: PublicSettings
  logs: LogEntry[]
  steps: MindStep[]
  state: PlayerState | null
}

/** Server-sent events, by event name. */
export interface PanelEvents {
  snapshot: Snapshot
  status: Status
  log: LogEntry
  step: MindStep
  delta: { id: number } & StreamDelta
  state: PlayerState
  settings: PublicSettings
  db: { table: DbTable }
}

export type PanelEvent = { [K in Exclude<keyof PanelEvents, 'snapshot'>]: { type: K; data: PanelEvents[K] } }[Exclude<keyof PanelEvents, 'snapshot'>]
