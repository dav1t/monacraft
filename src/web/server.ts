import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import { MAX_SELF_CHARS, MAX_WANTS_CHARS } from '../identity.ts'
import { errorMessage } from '../lib/text.ts'
import type { Controller } from './controller.ts'
import { itemIcon } from './icons.ts'
import { attachPov, POV_DIR } from './pov.ts'
import { minecraftSchema, settingsPatchSchema } from './settings.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
const MAX_BODY = 256 * 1024

/** A request the client got wrong; answered with 400 and the message. */
class BadRequest extends Error {}

type Handler = (ctx: { params: string[]; body: unknown; url: URL }) => unknown | Promise<unknown>

const content = z.object({ content: z.string().trim().min(1).max(2000) })
const memoryValue = z.object({ value: z.string().trim().min(1) })
const skillUpdate = z.object({ description: z.string().trim().min(1), code: z.string().min(1) })
const title = z.object({ title: z.string().trim().min(2).max(200) })
const goalEdit = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  status: z.enum(['todo', 'active', 'done', 'failed', 'dropped', 'paused']).optional(),
})
const pin = z.object({ pinned: z.boolean() })
const identityEdit = z.object({ self: z.string().trim().min(1).max(MAX_SELF_CHARS), wants: z.string().trim().min(1).max(MAX_WANTS_CHARS) })
const providerId = z.enum(['ollama', 'openai', 'anthropic', 'openrouter'])

/** Runs a goal-tree change; its errors (no active goal, offline…) are the client's to fix. */
async function clientError<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new BadRequest(errorMessage(err))
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequest(z.prettifyError(result.error))
  return result.data
}

function found(ok: boolean, what: string): { ok: true } {
  if (!ok) throw new BadRequest(`${what} not found`)
  return { ok: true }
}

function routes(controller: Controller): [string, RegExp, Handler][] {
  const { repos } = controller
  return [
    ['POST', /^\/api\/connect$/, async ({ body }) => {
      await controller.connect(parse(minecraftSchema, body))
      return { ok: true }
    }],
    ['POST', /^\/api\/disconnect$/, () => {
      controller.disconnect()
      return { ok: true }
    }],
    ['GET', /^\/api\/settings$/, () => controller.snapshot().settings],
    ['GET', /^\/api\/stats$/, () => controller.stats()],
    ['GET', /^\/api\/models$/, ({ url }) => {
      const provider = url.searchParams.get('provider')
      return controller.models(url.searchParams.get('refresh') === '1', provider === null ? undefined : parse(providerId, provider))
    }],
    ['PUT', /^\/api\/settings$/, ({ body }) => {
      controller.updateSettings(parse(settingsPatchSchema, body))
      return controller.snapshot().settings
    }],

    ['GET', /^\/api\/revelations$/, () => repos.revelations.list()],
    ['POST', /^\/api\/revelations$/, ({ body }) => controller.addRevelation(parse(content, body).content)],
    ['PUT', /^\/api\/revelations\/(\d+)$/, ({ params, body }) => {
      const result = found(repos.revelations.update(Number(params[0]), parse(content, body).content), 'revelation')
      controller.changed('revelations')
      return result
    }],
    ['DELETE', /^\/api\/revelations\/(\d+)$/, ({ params }) => {
      const result = found(repos.revelations.delete(Number(params[0])), 'revelation')
      controller.changed('revelations')
      return result
    }],

    ['GET', /^\/api\/memory$/, () => repos.memory.list()],
    ['PUT', /^\/api\/memory\/([^/]+)\/pin$/, ({ params, body }) => {
      const result = found(repos.memory.setPinned(params[0] as string, parse(pin, body).pinned), 'memory key')
      controller.changed('memory')
      return result
    }],
    ['PUT', /^\/api\/memory\/([^/]+)$/, ({ params, body }) => {
      repos.memory.set(params[0] as string, parse(memoryValue, body).value)
      controller.changed('memory')
      return { ok: true }
    }],
    ['DELETE', /^\/api\/memory\/([^/]+)$/, ({ params }) => {
      const result = found(repos.memory.delete(params[0] as string), 'memory key')
      controller.changed('memory')
      return result
    }],

    ['GET', /^\/api\/skills$/, () => repos.skills.list()],
    ['PUT', /^\/api\/skills\/([^/]+)$/, ({ params, body }) => {
      const result = found(repos.skills.update(params[0] as string, parse(skillUpdate, body)), 'skill')
      controller.changed('skills')
      return result
    }],
    ['DELETE', /^\/api\/skills\/([^/]+)$/, ({ params }) => {
      const result = found(repos.skills.delete(params[0] as string), 'skill')
      controller.changed('skills')
      return result
    }],

    ['GET', /^\/api\/goals$/, () => controller.goalsView()],
    ['POST', /^\/api\/goals$/, ({ body }) => clientError(() => controller.setGoal(parse(title, body).title))],
    ['PUT', /^\/api\/goals\/(\d+)$/, async ({ params, body }) => {
      const result = found(await clientError(() => controller.goals().edit(Number(params[0]), parse(goalEdit, body))), 'goal')
      controller.changed('goals')
      return result
    }],
    ['POST', /^\/api\/goals\/(\d+)\/children$/, async ({ params, body }) => {
      const row = await clientError(() => controller.goals().addChild(Number(params[0]), parse(title, body).title))
      controller.changed('goals')
      return row
    }],
    ['DELETE', /^\/api\/goals\/(\d+)$/, ({ params }) => {
      const result = found(repos.goals.delete(Number(params[0])), 'goal')
      controller.changed('goals')
      return result
    }],

    ['GET', /^\/api\/days$/, ({ url }) => repos.days.list(Math.min(Number(url.searchParams.get('limit')) || 30, 200))],
    ['POST', /^\/api\/nap$/, async () => {
      await clientError(() => controller.nap())
      return { ok: true }
    }],
    ['GET', /^\/api\/lessons$/, () => repos.lessons.list()],
    ['POST', /^\/api\/lessons$/, ({ body }) => {
      const lesson = repos.lessons.add(parse(content, body).content, 'player')
      controller.changed('lessons')
      return lesson
    }],
    ['PUT', /^\/api\/lessons\/(\d+)$/, ({ params, body }) => {
      const result = found(repos.lessons.update(Number(params[0]), parse(content, body).content), 'lesson')
      controller.changed('lessons')
      return result
    }],
    ['DELETE', /^\/api\/lessons\/(\d+)$/, ({ params }) => {
      const result = found(repos.lessons.delete(Number(params[0])), 'lesson')
      controller.changed('lessons')
      return result
    }],
    ['GET', /^\/api\/identity$/, () => repos.identity.list(50)],
    ['PUT', /^\/api\/identity$/, ({ body }) => {
      repos.identity.update({ ...parse(identityEdit, body), reason: 'player' })
      controller.changed('identity')
      return { ok: true }
    }],
    ['GET', /^\/api\/scars$/, () => repos.scars.list()],
    ['DELETE', /^\/api\/scars\/(\d+)$/, ({ params }) => {
      const result = found(repos.scars.delete(Number(params[0])), 'scar')
      controller.changed('scars')
      return result
    }],
    ['GET', /^\/api\/structures$/, () => repos.structures.list()],
    ['DELETE', /^\/api\/structures\/([^/]+)$/, ({ params }) => {
      const result = found(repos.structures.delete(params[0] as string), 'structure')
      controller.changed('structures')
      return result
    }],
    ['GET', /^\/api\/templates$/, () => repos.templates.list()],
    ['DELETE', /^\/api\/templates\/(goal|subgoal)\/([^/]+)$/, ({ params }) => {
      const result = found(repos.templates.delete(params[0] as 'goal' | 'subgoal', params[1] as string), 'template')
      controller.changed('templates')
      return result
    }],

    ['GET', /^\/api\/history$/, ({ url }) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
      const before = Number(url.searchParams.get('before')) || undefined
      return repos.history.page(limit, before)
    }],
    ['DELETE', /^\/api\/history\/(\d+)$/, ({ params }) => {
      const result = found(repos.history.delete(Number(params[0])), 'history entry')
      controller.changed('history')
      return result
    }],
    ['DELETE', /^\/api\/history$/, () => {
      repos.history.clear()
      controller.changed('history')
      return { ok: true }
    }],
  ]
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined
  // Requiring JSON forces a CORS preflight, so other websites cannot post to the panel.
  if (!req.headers['content-type']?.includes('application/json')) throw new BadRequest('expected a JSON body')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new BadRequest('body too large')
    chunks.push(chunk)
  }
  try {
    return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function openEventStream(controller: Controller, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const send = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  send('snapshot', controller.snapshot())
  const unsubscribe = controller.subscribe((event) => send(event.type, event.data))
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    unsubscribe()
    clearInterval(keepAlive)
  })
}

/** Rejects requests whose Host header is not the panel itself (DNS rebinding). */
function hostAllowed(req: IncomingMessage, bindHost: string): boolean {
  if (bindHost !== '127.0.0.1' && bindHost !== 'localhost' && bindHost !== '::1') return true
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host)
}

/** WebSockets skip CORS, so a page on another site could open one; only the panel's own pages may. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Serves the built UI; unknown paths get index.html. Returns false when there is nothing to serve. */
async function serveStatic(dir: string, pathname: string, res: ServerResponse, cacheAll = false): Promise<boolean> {
  const wanted = normalize(join(dir, decodeURIComponent(pathname)))
  const file = wanted.startsWith(normalize(dir) + sep) && extname(wanted) ? wanted : join(dir, 'index.html')
  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    if (file.endsWith('index.html')) return false
    res.writeHead(404).end()
    return true
  }
  // Vite puts a content hash in asset names, so those can be cached for good (as can everything when `cacheAll`).
  const immutable = (cacheAll && !file.endsWith('index.html')) || file.includes(`${sep}assets${sep}`)
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
  res.end(body)
  return true
}

export interface PanelServerOptions {
  bindHost: string
  /** Folder with the built UI (`vite build`). */
  staticDir?: string
  /** Connect-style handler for everything that is not /api, e.g. Vite's dev middleware. */
  ui?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
}

export function createPanelServer(controller: Controller, { bindHost, staticDir, ui }: PanelServerOptions): Server {
  const table = routes(controller)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://panel')
    if (!hostAllowed(req, bindHost)) return sendJson(res, 403, { error: 'forbidden host' })
    try {
      // The bot's view (prismarine-viewer's page); its socket.io path is handled by attachPov.
      if (url.pathname === '/pov') return res.writeHead(301, { location: '/pov/' }).end()
      if (url.pathname.startsWith('/pov/') && req.method === 'GET') {
        // The viewer's files only change with the pinned package version; worker.js alone is ~60 MB.
        if (await serveStatic(POV_DIR, url.pathname.slice('/pov'.length), res, true)) return
        return sendJson(res, 404, { error: 'not found' })
      }
      if (!url.pathname.startsWith('/api/')) {
        if (ui) return ui(req, res, () => sendJson(res, 404, { error: 'not found' }))
        if (req.method === 'GET' && staticDir && (await serveStatic(staticDir, url.pathname, res))) return
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('The panel UI is not built. Run `pnpm panel` (builds first) or `pnpm panel:dev`.')
      }
      if (req.method === 'GET' && url.pathname === '/api/events') return openEventStream(controller, req, res)
      const icon = req.method === 'GET' ? /^\/api\/icons\/([a-z0-9_]+)\.png$/.exec(url.pathname) : null
      if (icon) {
        const png = itemIcon(icon[1]!)
        if (!png) return sendJson(res, 404, { error: 'no icon' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
        return res.end(png)
      }

      let pathMatched = false
      for (const [method, pattern, handler] of table) {
        const match = pattern.exec(url.pathname)
        if (!match) continue
        pathMatched = true
        if (method !== req.method) continue
        const params = match.slice(1).map((p) => decodeURIComponent(p))
        return sendJson(res, 200, await handler({ params, body: await readBody(req), url }))
      }
      sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method not allowed' : 'not found' })
    } catch (err) {
      if (res.headersSent) return res.end()
      sendJson(res, err instanceof BadRequest ? 400 : 500, { error: errorMessage(err) })
    }
  })
  attachPov(server, () => controller.currentBot(), (req) => hostAllowed(req, bindHost) && sameOrigin(req))
  return server
}
