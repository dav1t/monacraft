import type { Bot } from 'mineflayer'
import { Agent, type AgentEvent } from './agent/agent.ts'
import { GoalKeeper } from './agent/goals.ts'
import { buildSystemPrompt } from './agent/prompt.ts'
import { connectBot, type ConnectOptions } from './bot/connect.ts'
import type { Repos } from './db/repos.ts'
import { watchDamage } from './damage.ts'
import { watchDeaths } from './death.ts'
import { Eyes, startEyes } from './eyes.ts'
import { ensureIdentity } from './identity.ts'
import { formatPos } from './lib/mc.ts'
import { errorMessage } from './lib/text.ts'
import type { LLMProvider } from './llm/types.ts'
import { startReflexes } from './reflexes.ts'
import { botWorld } from './planning/world.ts'
import { formatSnapshot } from './sensors/snapshot.ts'
import { readWorldState } from './sensors/world.ts'
import { SleepScheduler, type SleepEvent } from './sleep.ts'
import { allTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'

export interface SessionOptions {
  minecraft: ConnectOptions
  provider: LLMProvider
  repos: Repos
  log: (line: string) => void
  onAgentEvent?: (event: AgentEvent) => void
  onSleepEvent?: (event: SleepEvent) => void
  /** The connection closed without stop() being called (kicked, server down…). */
  onEnd?: (reason: string) => void
}

/** One bot connected to a server, with its agent and reflexes. The agent loop is started by the caller (agent.run()). */
export interface Session {
  bot: Bot
  agent: Agent
  sleep: SleepScheduler
  stop(): void
}

export async function startSession({ minecraft, provider, repos, log, onAgentEvent, onSleepEvent, onEnd }: SessionOptions): Promise<Session> {
  const { host, port, username, version } = minecraft
  log(`connecting to ${host}:${port} as ${username} (Minecraft ${version}), brain: ${provider.name}`)
  const bot = await connectBot(minecraft)
  log(`spawned at ${formatPos(bot.entity.position)}`)
  await bot.waitForChunksToLoad()
  repos.history.add('event', `connected at ${formatPos(bot.entity.position)}`)
  await ensureIdentity({ repos, provider, name: bot.username, log })

  const eyes = new Eyes()
  const agent = new Agent({
    provider,
    registry: new ToolRegistry().register(...allTools),
    repos,
    systemPrompt: buildSystemPrompt(bot.username),
    observe: () => formatSnapshot(readWorldState(bot, eyes)),
    context: { bot, repos, log },
    log,
    goals: new GoalKeeper(repos, botWorld(bot)),
    ...(onAgentEvent && { onEvent: onAgentEvent }),
  })
  const sleep = new SleepScheduler({ bot, agent, repos, provider, name: bot.username, log, ...(onSleepEvent && { onEvent: onSleepEvent }) })

  const onPlayerMessage = (from: string, message: string): void => {
    if (from !== bot.username) agent.onChat(from, message)
  }
  bot.on('chat', onPlayerMessage)
  bot.on('whisper', onPlayerMessage)
  // Put on the best armor carried, now and after every respawn (picked-up armor is handled by armorManager itself).
  const wearArmor = (): void => {
    bot.armorManager.equipAll().catch((err: unknown) => log(`could not put on armor: ${errorMessage(err)}`))
  }
  wearArmor()
  bot.on('spawn', wearArmor)
  // Stop the current action at once; watchDeaths records the cause a moment later and reflects on it.
  bot.on('death', () => agent.interrupt('you died'))
  const stopDeaths = watchDeaths({ bot, repos, sleep, log })
  const stopDamage = watchDamage(bot, agent, repos, log)
  bot.on('kicked', (reason) => log(`kicked: ${JSON.stringify(reason)}`))
  bot.on('error', (err) => log(`bot error: ${err.message}`))

  const stopReflexes = startReflexes(bot, agent, repos, log)
  const stopSleep = sleep.start()
  const stopEyes = startEyes(bot, eyes, agent, repos, log)
  let stopped = false
  bot.on('end', (reason) => {
    if (stopped) return
    stopped = true
    log(`disconnected (${reason})`)
    stopReflexes()
    stopSleep()
    stopDeaths()
    stopDamage()
    stopEyes()
    agent.stop()
    onEnd?.(reason)
  })

  return {
    bot,
    agent,
    sleep,
    stop() {
      if (stopped) return
      stopped = true
      stopReflexes()
      stopSleep()
      stopDeaths()
      stopDamage()
      stopEyes()
      agent.stop()
      bot.quit()
    },
  }
}
