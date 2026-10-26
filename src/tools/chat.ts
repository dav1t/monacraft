import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { defineTool } from './types.ts'

export const say = defineTool({
  name: 'say',
  description: 'Send a chat message to the players.',
  schema: z.object({ message: z.string().min(1) }),
  run: async ({ message }, { bot }) => {
    bot.chat(message.slice(0, 256))
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
