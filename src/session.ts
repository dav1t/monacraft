import type { Bot } from 'mineflayer'
import { Agent, type AgentEvent } from './agent/agent.ts'
import { buildSystemPrompt } from './agent/prompt.ts'
import { connectBot, type ConnectOptions } from './bot/connect.ts'
import type { Repos } from './db/repos.ts'
import { formatPos, isHostile, nearestEntity } from './lib/mc.ts'
import type { LLMProvider } from './llm/types.ts'
import { startReflexes } from './reflexes.ts'
import { formatSnapshot } from './sensors/snapshot.ts'
import { readWorldState } from './sensors/world.ts'
import { allTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'

export interface SessionOptions {
  minecraft: ConnectOptions
  provider: LLMProvider
  repos: Repos
  log: (line: string) => void
  onAgentEvent?: (event: AgentEvent) => void
  /** The connection closed without stop() being called (kicked, server down…). */
  onEnd?: (reason: string) => void
}

/** One bot connected to a server, with its agent and reflexes. The agent loop is started by the caller (agent.run()). */
export interface Session {
  bot: Bot
  agent: Agent
  stop(): void
}

export async function startSession({ minecraft, provider, repos, log, onAgentEvent, onEnd }: SessionOptions): Promise<Session> {
  const { host, port, username, version } = minecraft
  log(`connecting to ${host}:${port} as ${username} (Minecraft ${version}), brain: ${provider.name}`)
  const bot = await connectBot(minecraft)
  log(`spawned at ${formatPos(bot.entity.position)}`)
  await bot.waitForChunksToLoad()
  repos.history.add('event', `connected at ${formatPos(bot.entity.position)}`)

  const agent = new Agent({
    provider,
    registry: new ToolRegistry().register(...allTools),
    repos,
    systemPrompt: buildSystemPrompt(bot.username),
    observe: () => formatSnapshot(readWorldState(bot)),
    context: { bot, repos, log },
    log,
    ...(onAgentEvent && { onEvent: onAgentEvent }),
  })

  const onPlayerMessage = (from: string, message: string): void => {
    if (from !== bot.username) agent.onChat(from, message)
  }
  bot.on('chat', onPlayerMessage)
  bot.on('whisper', onPlayerMessage)
  bot.on('death', () => {
    repos.history.add('event', `you died at ${formatPos(bot.entity.position)} and respawned; your items dropped there`)
    agent.interrupt('you died')
  })
  let lastUnseenDamage = 0
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity || Date.now() - lastUnseenDamage < 10_000) return
    if (nearestEntity(bot, isHostile, 4)) return
    lastUnseenDamage = Date.now()
    repos.history.add('event', `you took damage from something out of reach (health ${Math.round(bot.health)})`)
  })
  bot.on('kicked', (reason) => log(`kicked: ${JSON.stringify(reason)}`))
  bot.on('error', (err) => log(`bot error: ${err.message}`))

  const stopReflexes = startReflexes(bot, agent, repos, log)
  let stopped = false
  bot.on('end', (reason) => {
    if (stopped) return
    stopped = true
    log(`disconnected (${reason})`)
    stopReflexes()
    agent.stop()
    onEnd?.(reason)
  })

  return {
    bot,
    agent,
    stop() {
      if (stopped) return
      stopped = true
      stopReflexes()
      agent.stop()
      bot.quit()
    },
  }
}
