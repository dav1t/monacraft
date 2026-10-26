import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/database.ts'
import { createRepos } from './db/repos.ts'
import { Controller } from './web/controller.ts'
import { createPanelServer, type PanelServerOptions } from './web/server.ts'
import { defaultSettings, loadSettings } from './web/settings.ts'

try {
  process.loadEnvFile()
} catch {
  // .env is optional
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** `--dev` runs Vite inside the panel server (hot reload); otherwise the built UI in dist/ui is served. */
async function uiOptions(dev: boolean): Promise<Omit<PanelServerOptions, 'bindHost'>> {
  if (!dev) return { staticDir: join(ROOT, 'dist', 'ui') }
  const { createServer } = await import('vite')
  const vite = await createServer({ configFile: join(ROOT, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'spa' })
  return { ui: vite.middlewares }
}

/** Panel mode: a web page to connect the bot, watch it think and edit its memory. .env only provides defaults. */
async function main(): Promise<void> {
  const config = loadConfig()
  const settingsPath = join(config.dbPath === ':memory:' ? 'data' : dirname(config.dbPath), 'panel.json')
  const controller = new Controller({
    repos: createRepos(openDatabase(config.dbPath)),
    settings: loadSettings(settingsPath, defaultSettings(config)),
    settingsPath,
    print: (line) => console.log(line),
  })

  const { host, port } = config.panel
  const server = createPanelServer(controller, { bindHost: host, ...(await uiOptions(process.argv.includes('--dev'))) })
  server.listen(port, host, () => console.log(`panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))

  process.once('SIGINT', () => {
    console.log('shutting down')
    controller.disconnect()
    server.closeAllConnections()
    server.close()
    setTimeout(() => process.exit(0), 500)
  })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
