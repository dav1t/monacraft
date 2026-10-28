import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { Repos } from './db/repos.ts'
import { errorMessage, truncate } from './lib/text.ts'
import { LLMFormatError, type LLMProvider } from './llm/types.ts'
import type { ToolSpec } from './tools/types.ts'

export const MAX_SELF_CHARS = 700
export const MAX_WANTS_CHARS = 350
const ATTEMPTS = 3
const RETRY_DELAY_MS = 5_000

// Chance words a bot is born with. Asked for "who are you", every model writes the same gear-hungry survivor; a few
// random words break the tie. They are not roles: the bot embraces, twists or rejects them as it likes.
const TEMPERAMENTS = [
  'patient', 'restless', 'stubborn', 'playful', 'cautious', 'bold', 'curious', 'melancholic', 'meticulous', 'impulsive',
  'gentle', 'proud', 'dreamy', 'practical', 'sociable', 'solitary', 'superstitious', 'sentimental', 'competitive',
  'easily bored', 'nostalgic', 'generous', 'greedy', 'shy', 'theatrical', 'stoic', 'anxious', 'cheerful', 'grumpy', 'romantic',
]
const DRAWN_TO = [
  'high places', 'the sound of water', 'old ruins', 'animals', 'symmetry', 'the night sky', 'deep caves', 'fire', 'flowers',
  'trading', 'maps and far places', 'quiet mornings', 'collecting rare things', 'tall towers', 'the sea', 'gardens',
  'redstone contraptions', 'strangers', 'snow', 'deserts', 'cozy small rooms', 'big open halls', 'secret passages',
  'stories and books', 'lights in the dark', 'bridges', 'mushrooms', 'bees', 'boats', 'mountains', 'villages', 'music',
  'colorful blocks', 'roads', 'being useful to others', 'record keeping', 'the moon', 'forests', 'islands', 'rain',
]
const FEARS = [
  'the dark', 'deep water', 'being forgotten', 'heights', 'losing things', 'crowds of mobs', 'hunger', 'being alone',
  'fire', 'wasting time', 'getting lost', 'open plains at night', 'caves', 'failure', 'being seen as weak', 'spiders',
  'storms', 'endings', 'running out of wood', 'the nether',
]

function pick<T>(list: T[], count: number, random: () => number): T[] {
  const pool = [...list]
  const picked: T[] = []
  while (picked.length < count && pool.length > 0) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!)
  return picked
}

/** e.g. "temperament: stubborn, dreamy; drawn to: bridges, the sea; afraid of: being forgotten" */
export function drawSeeds(random: () => number = Math.random): string {
  return `temperament: ${pick(TEMPERAMENTS, 2, random).join(', ')}; drawn to: ${pick(DRAWN_TO, 2, random).join(', ')}; afraid of: ${pick(FEARS, 1, random)[0]}`
}

const identitySpec = z.object({
  self: z.string().describe('who you are, first person, 3-5 sentences: your temperament, what you care about, what you dream of'),
  wants: z.string().describe('what you want now, first person, 1-3 concrete things you could start on in this world'),
})

export const identityInput = z.object({
  self: z.string().trim().min(1).transform((s) => truncate(s, MAX_SELF_CHARS)),
  wants: z.string().trim().min(1).transform((s) => truncate(s, MAX_WANTS_CHARS)),
})

export function writeIdentitySpec(): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(identitySpec) as Record<string, unknown>
  return { name: 'write_identity', description: 'Write down who you are and what you want.', parameters }
}

export function birthPrompt(name: string): string {
  return `You are ${name}, about to be born into a Minecraft Java survival world. Nobody will tell you what to do with your life.
Call write_identity exactly once to write down who you are and what you want, in your own words.
Some words came to you by chance. Make of them what you like: embrace them, twist them or reject them.
Don't fall back on the usual "gather resources and get the best gear" story just because it is common; want that only if it is truly you.`
}

export interface BirthOptions {
  repos: Repos
  provider: LLMProvider
  name: string
  log: (line: string) => void
  random?: () => number
  wait?: (ms: number) => Promise<void>
}

/**
 * Gives a bot without an identity one: it writes its own from a few chance words. Without a usable answer the bot
 * lives on without one and is born at the next connect.
 */
export async function ensureIdentity({ repos, provider, name, log, random, wait = sleep }: BirthOptions): Promise<void> {
  if (repos.identity.current()) return
  const seeds = drawSeeds(random)
  log(`🌱 being born (${seeds})`)
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const decision = await provider.decide({
        system: birthPrompt(name),
        user: `Chance words: ${seeds}\n\nCall write_identity now.`,
        tools: [writeIdentitySpec()],
        purpose: 'reflection',
      })
      if (decision.tool !== 'write_identity') throw new LLMFormatError(`called ${decision.tool} instead of write_identity`)
      const parsed = identityInput.safeParse(decision.args)
      if (!parsed.success) throw new LLMFormatError(`invalid identity: ${z.prettifyError(parsed.error)}`)
      repos.identity.update({ ...parsed.data, reason: 'birth', seeds })
      log(`🌱 ${parsed.data.self}`)
      log(`🌱 wants: ${parsed.data.wants}`)
      return
    } catch (err) {
      log(`⚠ birth attempt ${attempt} failed: ${errorMessage(err)}`)
      if (attempt < ATTEMPTS && !(err instanceof LLMFormatError)) await wait(RETRY_DELAY_MS)
    }
  }
  log('⚠ no identity yet: the bot lives without one and tries again at the next connect')
}
