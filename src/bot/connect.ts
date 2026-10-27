import mineflayer, { type Bot } from 'mineflayer'
import armorManager from 'mineflayer-armor-manager'
import { plugin as pvp } from 'mineflayer-pvp'
import { recordDamageTypes } from '../damage.ts'
import { Movements, pathfinder } from '../lib/mc.ts'

export interface ConnectOptions {
  host: string
  port: number
  username: string
  version: string
}

/** Node reports ECONNREFUSED as an AggregateError with an empty message; fall back to the code or the first inner error. */
function describeConnectError(err: Error): string {
  const inner = (err as { errors?: Error[] }).errors?.[0]
  const code = (err as { code?: string }).code ?? (inner as { code?: string } | undefined)?.code
  return err.message || code || inner?.message || err.name
}

export async function connectBot(options: ConnectOptions): Promise<Bot> {
  const bot = mineflayer.createBot({ ...options, auth: 'offline' })
  recordDamageTypes(bot)
  bot.loadPlugin(pathfinder)
  // pvp: melee timed to the attack cooldown, shield against creepers. armorManager: wears the best armor picked up.
  bot.loadPlugin(pvp)
  bot.loadPlugin(armorManager)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('kicked', onKicked)
      bot.removeListener('error', onError)
    }
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onKicked = (reason: unknown) => {
      cleanup()
      reject(new Error(`kicked while joining: ${JSON.stringify(reason)}`))
    }
    const onError = (err: Error) => {
      cleanup()
      reject(new Error(`cannot connect to ${options.host}:${options.port} (${describeConnectError(err)}) — is the server running?`))
    }
    bot.once('spawn', onSpawn)
    bot.once('kicked', onKicked)
    bot.once('error', onError)
  })
  bot.pathfinder.setMovements(new Movements(bot))
  // pvp brings its own pathfinder settings; it should move like the rest of the bot.
  bot.pvp.movements = bot.pathfinder.movements
  return bot
}
