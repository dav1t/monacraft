import { loadConfig } from './config.ts'
import { openDatabase } from './db/database.ts'
import { createRepos } from './db/repos.ts'
import { createProvider } from './llm/providers.ts'
import { startSession } from './session.ts'

try {
  process.loadEnvFile()
} catch {
  // .env is optional
}

const log = (line: string): void => console.log(`[${new Date().toLocaleTimeString()}] ${line}`)

/** Headless mode: settings from .env, logs to the terminal. */
async function main(): Promise<void> {
  const config = loadConfig()
  const session = await startSession({
    minecraft: config.minecraft,
    provider: createProvider(config.llm),
    repos: createRepos(openDatabase(config.dbPath)),
    log,
    onEnd: () => process.exit(1),
  })

  process.once('SIGINT', () => {
    log('shutting down')
    session.stop()
    setTimeout(() => process.exit(0), 500)
  })

  await session.agent.run()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
