import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { openDatabase } from '../db/database.ts'
import { createRepos } from '../db/repos.ts'
import { errorMessage } from '../lib/text.ts'
import { Controller, type ControllerOptions } from './controller.ts'
import type { BotSummary } from './protocol.ts'
import { loadSettings, saveSettings, type PanelSettings } from './settings.ts'

/** Where one bot keeps its mind. Bots share nothing but the Minecraft server they play on. */
export interface BotEntry {
  id: string
  dbPath: string
  settingsPath: string
}

export interface FleetOptions {
  /** Data folder: the bot list (bots.json) and each added bot's folder (bots/<id>/). */
  dir: string
  /** The first bot's database (DB_PATH), used when there is no bot list yet. ':memory:' keeps every bot in memory. */
  firstDbPath: string
  defaults: PanelSettings
  print?: (line: string) => void
  /** Replaceable in tests. */
  controller?: Pick<ControllerOptions, 'startSession' | 'createProvider'>
}

interface Member {
  entry: BotEntry
  controller: Controller
  db: DatabaseSync
  unsubscribe: () => void
}

const entrySchema = z.array(z.object({ id: z.string(), dbPath: z.string(), settingsPath: z.string() }))

/** All bots of the panel, each with its own controller, database and settings. */
export class Fleet {
  readonly #options: FleetOptions
  readonly #registryPath: string
  readonly #members = new Map<string, Member>()
  readonly #listeners = new Set<(bots: BotSummary[]) => void>()
  #last = ''

  constructor(options: FleetOptions) {
    this.#options = options
    this.#registryPath = join(options.dir, 'bots.json')
    for (const entry of this.#loadEntries()) this.#open(entry)
    this.#save()
  }

  get(id: string): Controller | undefined {
    return this.#members.get(id)?.controller
  }

  list(): BotSummary[] {
    return [...this.#members.values()].map(({ entry, controller }) => {
      const { connection, brain, server, username, provider, model } = controller.status()
      return { id: entry.id, username, server, connection, brain, provider, model }
    })
  }

  subscribe(listener: (bots: BotSummary[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** A new bot with an empty mind. Server and brain settings are copied from `from` (API keys included) so it can join right away. */
  add(username: string, from?: string): BotSummary {
    const source = from === undefined ? undefined : this.#members.get(from)
    if (from !== undefined && !source) throw new Error(`bot "${from}" not found`)
    const id = this.#freeId(username)
    const memory = this.#options.firstDbPath === ':memory:'
    const dir = join(this.#options.dir, 'bots', id)
    const entry: BotEntry = { id, dbPath: memory ? ':memory:' : join(dir, 'agent.db'), settingsPath: join(dir, 'panel.json') }
    const base = source ? source.controller.settings() : this.#options.defaults
    saveSettings(entry.settingsPath, { ...base, minecraft: { ...base.minecraft, username } })
    this.#open(entry)
    this.#save()
    this.#emit()
    return this.list().find((bot) => bot.id === id)!
  }

  /** Takes an offline bot off the panel. Its database and settings stay on disk. */
  remove(id: string): BotEntry {
    const member = this.#members.get(id)
    if (!member) throw new Error(`bot "${id}" not found`)
    if (member.controller.status().connection !== 'offline') throw new Error('disconnect the bot first')
    if (this.#members.size === 1) throw new Error('the last bot cannot be removed')
    member.unsubscribe()
    this.#members.delete(id)
    try {
      member.db.close()
    } catch {
      // already closed
    }
    this.#save()
    this.#emit()
    return member.entry
  }

  disconnectAll(): void {
    for (const { controller } of this.#members.values()) controller.disconnect()
  }

  #open(entry: BotEntry): void {
    const db = openDatabase(entry.dbPath)
    const print = this.#options.print ?? (() => {})
    const controller = new Controller({
      ...this.#options.controller,
      repos: createRepos(db),
      settings: loadSettings(entry.settingsPath, this.#options.defaults),
      settingsPath: entry.settingsPath,
      print: (line) => print(`${line.replace(/^(\[[^\]]*\]) /, `$1 ${entry.id}: `)}`),
      // Two bots with one name on one server would keep kicking each other off.
      beforeConnect: ({ host, port, username }) => {
        const clash = [...this.#members.values()].find(
          (m) => m.entry.id !== entry.id && m.controller.status().connection !== 'offline' && sameAccount(m.controller.settings().minecraft, { host, port, username }),
        )
        if (clash) throw new Error(`${username} is already on ${host}:${port} (bot "${clash.entry.id}")`)
      },
      // Bots talking to each other would otherwise abort each other's every action.
      isPeer: (username) => this.#peers(entry.id).some((m) => m.controller.status().username.toLowerCase() === username.toLowerCase()),
    })
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'status' || event.type === 'settings') this.#emit()
    })
    this.#members.set(entry.id, { entry, controller, db, unsubscribe })
  }

  /** The other bots that are online on the same server as `id`. */
  #peers(id: string): Member[] {
    const self = this.#members.get(id)
    if (!self) return []
    const { host, port } = self.controller.settings().minecraft
    return [...this.#members.values()].filter((m) => {
      const other = m.controller.settings().minecraft
      return m.entry.id !== id && m.controller.status().connection === 'online' && other.host === host && other.port === port
    })
  }

  #emit(): void {
    const bots = this.list()
    const json = JSON.stringify(bots)
    if (json === this.#last) return
    this.#last = json
    for (const listener of this.#listeners) listener(bots)
  }

  /** The saved bot list; without one, the single bot the panel had before (DB_PATH and panel.json). */
  #loadEntries(): BotEntry[] {
    try {
      const entries = entrySchema.parse(JSON.parse(readFileSync(this.#registryPath, 'utf8')))
      if (entries.length > 0) return entries
    } catch (err) {
      if (existsSync(this.#registryPath)) this.#options.print?.(`⚠ ignoring unreadable ${this.#registryPath}: ${errorMessage(err)}`)
    }
    const settingsPath = join(this.#options.dir, 'panel.json')
    const { username } = loadSettings(settingsPath, this.#options.defaults).minecraft
    return [{ id: slug(username), dbPath: this.#options.firstDbPath, settingsPath }]
  }

  #save(): void {
    try {
      mkdirSync(this.#options.dir, { recursive: true })
      writeFileSync(this.#registryPath, `${JSON.stringify([...this.#members.values()].map((m) => m.entry), null, 2)}\n`)
    } catch (err) {
      this.#options.print?.(`⚠ could not save the bot list: ${errorMessage(err)}`)
    }
  }

  /** An id no bot has, and no removed bot's folder either (a new bot must not wake up with an old mind). */
  #freeId(username: string): string {
    const base = slug(username)
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (!this.#members.has(id) && !existsSync(join(this.#options.dir, 'bots', id))) return id
    }
  }
}

function slug(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'bot'
}

function sameAccount(a: { host: string; port: number; username: string }, b: { host: string; port: number; username: string }): boolean {
  return a.host === b.host && a.port === b.port && a.username.toLowerCase() === b.username.toLowerCase()
}
