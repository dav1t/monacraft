import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ConnectOptions } from '../bot/connect.ts'
import type { Config } from '../config.ts'
import type { LLMSettings, ProviderId } from '../llm/providers.ts'
import type { PublicSettings } from './protocol.ts'

/** What the panel remembers between runs: the last server and every provider's settings. */
export interface PanelSettings {
  minecraft: ConnectOptions
  active: ProviderId
  providers: Config['providers']
}

const port = z.coerce.number().int().min(1).max(65535)
const text = z.string().trim().min(1)

export const minecraftSchema = z.object({
  host: text,
  port,
  username: z.string().regex(/^\w{3,16}$/, '3-16 letters, digits or _'),
  version: text,
})

/** Partial update from the panel. An empty or missing apiKey keeps the stored key; null clears it. */
export const settingsPatchSchema = z.object({
  minecraft: minecraftSchema.optional(),
  active: z.enum(['ollama', 'openai', 'anthropic']).optional(),
  providers: z
    .object({
      ollama: z
        .object({
          host: text,
          model: text,
          mode: z.enum(['tools', 'json']),
          think: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]),
          numCtx: z.coerce.number().int().min(2048),
        })
        .partial()
        .optional(),
      openai: z.object({ baseURL: z.url(), model: text, apiKey: z.string().nullable() }).partial().optional(),
      anthropic: z
        .object({ model: text, effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']), apiKey: z.string().nullable() })
        .partial()
        .optional(),
    })
    .optional(),
})

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export function defaultSettings(config: Config): PanelSettings {
  return { minecraft: config.minecraft, active: config.llm.provider, providers: config.providers }
}

/** Saved settings on top of the defaults; a missing or unreadable file just means defaults. */
export function loadSettings(path: string, defaults: PanelSettings): PanelSettings {
  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return defaults
  }
  const patch = settingsPatchSchema.safeParse(saved)
  return patch.success ? applyPatch(defaults, patch.data) : defaults
}

export function saveSettings(path: string, settings: PanelSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

export function applyPatch(settings: PanelSettings, patch: SettingsPatch): PanelSettings {
  const { ollama, openai, anthropic } = patch.providers ?? {}
  return {
    minecraft: patch.minecraft ?? settings.minecraft,
    active: patch.active ?? settings.active,
    providers: {
      ollama: { ...settings.providers.ollama, ...ollama },
      openai: { ...settings.providers.openai, ...openai, apiKey: nextKey(settings.providers.openai.apiKey, openai?.apiKey) },
      anthropic: { ...settings.providers.anthropic, ...anthropic, apiKey: nextKey(settings.providers.anthropic.apiKey, anthropic?.apiKey) },
    },
  }
}

function nextKey(current: string, incoming: string | null | undefined): string {
  if (incoming === null) return ''
  return incoming ? incoming : current
}

export function activeLLM(settings: PanelSettings): LLMSettings {
  return settings.providers[settings.active]
}

/** Settings as sent to the browser: API keys are never sent back, only whether one is stored. */
export function publicSettings(settings: PanelSettings): PublicSettings {
  const { openai, anthropic } = settings.providers
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: { ...openai, apiKey: '', hasApiKey: openai.apiKey !== '' },
      anthropic: { ...anthropic, apiKey: '', hasApiKey: anthropic.apiKey !== '' },
    },
  }
}
