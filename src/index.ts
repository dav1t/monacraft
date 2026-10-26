import { Agent } from './agent/agent.ts'
import { buildSystemPrompt } from './agent/prompt.ts'
import { connectBot } from './bot/connect.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/database.ts'
import { createRepos } from './db/repos.ts'
import { formatPos, isHostile, nearestEntity } from './lib/mc.ts'
import { OllamaProvider } from './llm/ollama.ts'
import { startReflexes } from './reflexes.ts'
import { formatSnapshot } from './sensors/snapshot.ts'
import { readWorldState } from './sensors/world.ts'
import { allTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'

try {
  process.loadEnvFile()
} catch {
  // .env is optional
}

const log = (line: string): void => console.log(`[${new Date().toLocaleTimeString()}] ${line}`)

async function main(): Promise<void> {
  const config = loadConfig()
  const repos = createRepos(openDatabase(config.dbPath))
  const provider = new OllamaProvider(config.llm)
  const { host, port, username, version } = config.minecraft

  log(`connecting to ${host}:${port} as ${username} (Minecraft ${version}), brain: ${provider.name}`)
  const bot = await connectBot(config.minecraft)
  log(`spawned at ${formatPos(bot.entity.position)}`)
  await bot.waitForChunksToLoad()
  repos.history.add('event', `connected at ${formatPos(bot.entity.position)}`)

  const agent = new Agent({
    provider,
    registry: new ToolRegistry().register(...allTools),
    repos,
    systemPrompt: buildSystemPrompt(username),
    observe: () => formatSnapshot(readWorldState(bot)),
    context: { bot, repos, log },
    log,
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
  bot.on('end', (reason) => {
    log(`disconnected (${reason}), exiting`)
    process.exit(1)
  })

  const stopReflexes = startReflexes(bot, agent, repos, log)
  process.once('SIGINT', () => {
    log('shutting down')
    stopReflexes()
    agent.stop()
    bot.removeAllListeners('end')
    bot.quit()
    setTimeout(() => process.exit(0), 500)
  })

  await agent.run()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
