import type { IncomingMessage, Server } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Bot } from 'mineflayer'
import { Server as SocketServer } from 'socket.io'
import { remapChunk, stateRemap, type BlockData } from './blockRemap.ts'

// The bot's point of view, rendered in the browser by prismarine-viewer. Its prebuilt page lives under /pov/ and talks
// over socket.io on the panel's own port; this replaces the viewer's mineflayer plugin, which starts its own server.

const require = createRequire(import.meta.url)
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView') as { WorldView: WorldViewClass }
const { getVersion } = require('prismarine-viewer/viewer/lib/version') as { getVersion: (version: string) => string | null }
const minecraftData = require('minecraft-data') as (version: string) => { blocksArray: BlockData[] }

export const POV_DIR = join(dirname(require.resolve('prismarine-viewer/package.json')), 'public')
const VIEW_DISTANCE = 6

interface Emitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  emit(event: string, data: unknown): unknown
}

interface WorldViewInstance {
  init(pos: unknown): Promise<void>
  updatePosition(pos: unknown): Promise<void>
  listenToBot(bot: Bot): void
  removeListenersFromBot(bot: Bot): void
}

type WorldViewClass = new (world: unknown, viewDistance: number, position: unknown, emitter: Emitter) => WorldViewInstance

const remaps = new Map<string, Uint32Array>()

/** State ids of `version` translated to the viewer's `viewerVersion`; null when they are the same. */
function remapFor(bot: Bot, viewerVersion: string): Uint32Array | null {
  if (viewerVersion === bot.version) return null
  const key = `${bot.version}>${viewerVersion}`
  let map = remaps.get(key)
  if (!map) {
    map = stateRemap(bot.registry.blocksArray as unknown as BlockData[], minecraftData(viewerVersion).blocksArray)
    remaps.set(key, map)
  }
  return map
}

/** Lets each browser on /pov/ watch the current bot; `allow` vets the handshake like any other panel request. */
export function attachPov(server: Server, currentBot: () => Bot | null, allow: (req: IncomingMessage) => boolean): void {
  const io = new SocketServer(server, { path: '/pov/socket.io', serveClient: false, allowRequest: (req, done) => done(null, allow(req)) })
  io.on('connection', (socket) => {
    const bot = currentBot()
    const version = bot && getVersion(bot.version)
    if (!bot || !version) {
      socket.disconnect(true)
      return
    }
    const map = remapFor(bot, version)
    socket.emit('version', version)

    const emitter: Emitter = {
      on: (event, listener) => socket.on(event, listener),
      emit: (event, data) => {
        if (map && event === 'loadChunk') {
          const chunk = data as { chunk: string }
          data = { ...chunk, chunk: remapChunk(chunk.chunk, map) }
        } else if (map && event === 'blockUpdate') {
          const update = data as { stateId: number }
          data = { ...update, stateId: map[update.stateId] ?? 0 }
        }
        return socket.emit(event, data)
      },
    }
    const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position, emitter)
    void worldView.init(bot.entity.position)

    const onMove = (): void => {
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, addMesh: true })
      void worldView.updatePosition(bot.entity.position)
    }
    const onEnd = (): void => {
      socket.disconnect(true)
    }
    bot.on('move', onMove)
    bot.once('end', onEnd)
    worldView.listenToBot(bot)
    socket.on('disconnect', () => {
      bot.removeListener('move', onMove)
      bot.removeListener('end', onEnd)
      worldView.removeListenersFromBot(bot)
    })
  })
}
