import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { Fleet } from './web/fleet.ts'
import { createPanelServer, type PanelServerOptions } from './web/server.ts'
import { defaultSettings } from './web/settings.ts'

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

/** Panel mode: a web page to connect bots, watch them think and edit their memory. .env only provides defaults. */
async function main(): Promise<void> {
  const config = loadConfig()
  const fleet = new Fleet({
    dir: config.dbPath === ':memory:' ? 'data' : dirname(config.dbPath),
    firstDbPath: config.dbPath,
    defaults: defaultSettings(config),
    print: (line) => console.log(line),
  })

  const { host, port } = config.panel
  const server = createPanelServer(fleet, { bindHost: host, ...(await uiOptions(process.argv.includes('--dev'))) })
  server.listen(port, host, () => console.log(`panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))

  process.once('SIGINT', () => {
    console.log('shutting down')
    fleet.disconnectAll()
    server.closeAllConnections()
    server.close()
    setTimeout(() => process.exit(0), 500)
  })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
