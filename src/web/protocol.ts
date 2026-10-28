// Types shared by the panel server and the Svelte UI. Keep this file free of runtime imports.
import type { ConnectOptions } from '../bot/connect.ts'
import type { GoalTree } from '../agent/goals.ts'
import type { Day, GoalRow, GoalStatus, HistoryEntry, Identity, Lesson, MemoryEntry, ModelStats, PlanTemplate, Revelation, Scar, Skill, Structure } from '../db/repos.ts'
import type { ModelInfo } from '../llm/models.ts'
import type { AnthropicSettings, OllamaSettings, OpenAISettings, OpenRouterSettings, ProviderId } from '../llm/providers.ts'
import type { Decision, StreamDelta } from '../llm/types.ts'
import type { PlayerState, SlotItem } from './state.ts'

export type {
  Day,
  Decision,
  GoalRow,
  GoalStatus,
  GoalTree,
  HistoryEntry,
  Identity,
  Lesson,
  MemoryEntry,
  ModelInfo,
  ModelStats,
  PlanTemplate,
  PlayerState,
  ProviderId,
  Revelation,
  Scar,
  Skill,
  SlotItem,
  StreamDelta,
  Structure,
}

/** The goal tree and the last few finished goals, for the panel. */
export interface GoalsView {
  tree: GoalTree | null
  past: GoalRow[]
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online'
export type BrainStatus = 'idle' | 'deciding' | 'acting' | 'paused' | 'sleeping'

export interface Status {
  connection: ConnectionStatus
  brain: BrainStatus
  error: string | null
  server: string
  username: string
  provider: string
  /** The active model. */
  model: string
  /** What this (or the last) session's model calls cost, in USD; null when nothing reported a cost. */
  sessionCost: number | null
  /** Tokens the model read for the last decision (0 before the first one). */
  promptTokens: number
  /** True when the provider did not report the count and it was estimated. */
  promptTokensEstimated: boolean
  /** The model's context window in tokens, when known (Ollama's num_ctx). */
  contextTokens: number | null
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
  promptTokens?: number
  /** The model that made this decision, and what it used. */
  model?: string
  cost?: number
  inputTokens?: number
  outputTokens?: number
  decision?: Decision
  outcome?: string
  invalid?: string
}

/** The active provider's models; `models` is null when they cannot be listed (the panel then shows no dropdown). */
export interface ModelList {
  provider: ProviderId
  current: string
  models: ModelInfo[] | null
  error?: string
}

/** Settings as the browser sees them: API keys blanked, with a flag saying whether one is stored. */
export interface PublicSettings {
  minecraft: ConnectOptions
  active: ProviderId
  providers: {
    ollama: OllamaSettings
    openai: OpenAISettings & { hasApiKey: boolean }
    anthropic: AnthropicSettings & { hasApiKey: boolean }
    openrouter: OpenRouterSettings & { hasApiKey: boolean }
  }
}

export type DbTable =
  | 'memory' | 'skills' | 'history' | 'revelations' | 'goals' | 'days' | 'lessons' | 'templates' | 'structures' | 'llm_calls' | 'identity' | 'scars'

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
