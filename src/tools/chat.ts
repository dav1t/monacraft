import type { Bot } from 'mineflayer'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { overlap } from '../lib/words.ts'
import { defineTool, ToolError } from './types.ts'

/** A message this similar to one said within the window counts as a repeat. */
const REPEAT_SIMILARITY = 0.8
const REPEAT_WINDOW_MS = 3 * 60_000
const recentMessages = new WeakMap<Bot, { text: string; at: number }[]>()

export const say = defineTool({
  name: 'say',
  description: 'Send a chat message to the players.',
  schema: z.object({ message: z.string().min(1) }),
  run: async ({ message }, { bot }) => {
    const now = Date.now()
    const recent = (recentMessages.get(bot) ?? []).filter((m) => now - m.at < REPEAT_WINDOW_MS)
    // Small models get stuck re-sending the same line; refuse it so the error pushes them to act instead.
    if (recent.some((m) => m.text === message || overlap(message, m.text) >= REPEAT_SIMILARITY)) {
      throw new ToolError('you already said that a moment ago — players heard you; act on your goal instead of repeating it')
    }
    bot.chat(message.slice(0, 256))
    recentMessages.set(bot, [...recent, { text: message, at: now }].slice(-5))
    return 'sent'
  },
})

export const wait = defineTool({
  name: 'wait',
  description: 'Do nothing for a while (e.g. waiting for a player to answer). Ends early if someone talks.',
  schema: z.object({ seconds: z.number().int().min(1).max(60).default(10) }),
  run: async ({ seconds }, { signal }) => {
    await sleep(seconds * 1_000, undefined, { signal })
    return `waited ${seconds}s`
  },
})
