import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepos } from '../src/db/repos.ts'
import type { LLMProvider } from '../src/llm/types.ts'
import type { Session, SessionOptions } from '../src/session.ts'
import { Controller } from '../src/web/controller.ts'
import type { MindStep, PanelEvent } from '../src/web/protocol.ts'
import { createPanelServer } from '../src/web/server.ts'
import { applyPatch, defaultSettings, loadSettings, publicSettings } from '../src/web/settings.ts'

const defaults = () => defaultSettings(loadConfig({ ANTHROPIC_API_KEY: 'secret' }))

describe('panel settings', () => {
  it('keeps a stored key when the patch leaves it empty, and clears it on null', () => {
    const settings = defaults()
    expect(applyPatch(settings, { providers: { anthropic: { apiKey: '' } } }).providers.anthropic.apiKey).toBe('secret')
    expect(applyPatch(settings, { providers: { anthropic: { apiKey: 'new' } } }).providers.anthropic.apiKey).toBe('new')
    expect(applyPatch(settings, { providers: { anthropic: { apiKey: null } } }).providers.anthropic.apiKey).toBe('')
    const switched = applyPatch(settings, { active: 'anthropic', providers: { anthropic: { effort: 'high' } } })
    expect(switched.active).toBe('anthropic')
    expect(switched.providers.anthropic).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('stores OpenRouter settings and keeps its key', () => {
    const settings = applyPatch(defaults(), { active: 'openrouter', providers: { openrouter: { model: 'x/y', apiKey: 'k' } } })
    expect(settings.active).toBe('openrouter')
    expect(settings.providers.openrouter).toEqual({ provider: 'openrouter', model: 'x/y', apiKey: 'k' })
    expect(applyPatch(settings, { providers: { openrouter: { apiKey: '' } } }).providers.openrouter.apiKey).toBe('k')
    expect(publicSettings(settings).providers.openrouter).toMatchObject({ apiKey: '', hasApiKey: true })
  })

  it('fills in OpenRouter for settings saved before it existed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'monacraft-')), 'panel.json')
    writeFileSync(path, JSON.stringify({ active: 'ollama', providers: { ollama: { model: 'qwen3:8b' } } }))
    expect(loadSettings(path, defaults()).providers.openrouter).toEqual(defaults().providers.openrouter)
  })

  it('never sends keys to the browser', () => {
    const shown = publicSettings(defaults())
    expect(shown.providers.anthropic).toMatchObject({ apiKey: '', hasApiKey: true })
    expect(shown.providers.openai).toMatchObject({ apiKey: '', hasApiKey: false })
  })

  it('loads saved settings over defaults and ignores broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monacraft-'))
    const path = join(dir, 'panel.json')
    expect(loadSettings(path, defaults())).toEqual(defaults())
    writeFileSync(path, JSON.stringify({ minecraft: { host: 'mc.local', port: 25570, username: 'Bob', version: '1.21.11' } }))
    expect(loadSettings(path, defaults()).minecraft.host).toBe('mc.local')
    writeFileSync(path, '{nope')
    expect(loadSettings(path, defaults())).toEqual(defaults())
  })
})

describe('panel server', () => {
  let close: () => void = () => {}
  afterEach(() => close())

  async function start() {
    const dir = mkdtempSync(join(tmpdir(), 'monacraft-'))
    const repos = createRepos(openDatabase(':memory:'))
    const controller = new Controller({ repos, settings: defaults(), settingsPath: join(dir, 'panel.json') })
    const events: PanelEvent[] = []
    controller.subscribe((e) => events.push(e))
    const server = createPanelServer(controller, { bindHost: '127.0.0.1' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    close = () => server.close()
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as unknown }
    }
    return { base, call, repos, events, dir }
  }

  it('manages revelations and records them in the history', async () => {
    const { call, repos, events } = await start()
    const added = await call('POST', '/api/revelations', { content: 'logs make planks' })
    expect(added.status).toBe(200)
    const id = (added.body as { id: number }).id
    expect(repos.history.recent(1)[0]?.content).toBe('a revelation arrived from your creator: logs make planks')
    expect(events.some((e) => e.type === 'log' && e.data.text.includes('logs make planks'))).toBe(true)
    expect((await call('PUT', `/api/revelations/${id}`, { content: 'logs give 4 planks' })).status).toBe(200)
    expect((await call('GET', '/api/revelations')).body).toMatchObject([{ id, content: 'logs give 4 planks' }])
    expect((await call('DELETE', `/api/revelations/${id}`)).status).toBe(200)
    expect((await call('DELETE', `/api/revelations/${id}`)).status).toBe(400)
    expect((await call('POST', '/api/revelations', { content: '  ' })).status).toBe(400)
  })

  it('edits memory, skills and history', async () => {
    const { call, repos } = await start()
    expect((await call('PUT', '/api/memory/base', { value: '1 64 2' })).status).toBe(200)
    expect((await call('PUT', '/api/memory/base/pin', { pinned: true })).status).toBe(200)
    expect((await call('GET', '/api/memory')).body).toMatchObject([{ key: 'base', value: '1 64 2', pinned: true }])
    expect((await call('DELETE', '/api/memory/base')).status).toBe(200)

    repos.skills.create({ name: 'chop', description: 'chop', code: 'return 1' })
    expect((await call('PUT', '/api/skills/chop', { description: 'chop trees', code: 'return 2' })).status).toBe(200)
    expect(repos.skills.get('chop')).toMatchObject({ description: 'chop trees', code: 'return 2' })
    expect((await call('DELETE', '/api/skills/chop')).status).toBe(200)

    for (const n of [1, 2, 3]) repos.history.add('event', `e${n}`)
    const page = (await call('GET', '/api/history?limit=2')).body as { id: number }[]
    expect(page).toHaveLength(2)
    expect((await call('DELETE', `/api/history/${page[0]!.id}`)).status).toBe(200)
    expect((await call('DELETE', '/api/history')).status).toBe(200)
    expect(repos.history.page(10)).toEqual([])
  })

  it('edits the goal tree, lessons, days and templates', async () => {
    const { call, repos, events } = await start()
    const set = await call('POST', '/api/goals', { title: 'build a shelter' })
    expect(set.body).toMatchObject({ tree: { goal: { title: 'build a shelter', status: 'active' }, subgoals: [] } })
    expect(repos.history.recent(1)[0]?.content).toBe('your creator set your goal: build a shelter')
    const goalId = repos.goals.active()!.id
    const sub = (await call('POST', `/api/goals/${goalId}/children`, { title: 'gather dirt' })).body as { id: number }
    await call('POST', `/api/goals/${goalId}/children`, { title: 'build walls' })
    expect((await call('PUT', `/api/goals/${sub.id}`, { status: 'done' })).status).toBe(200)
    const view = (await call('GET', '/api/goals')).body as { tree: { subgoals: { title: string; status: string }[] } }
    expect(view.tree.subgoals.map((s) => `${s.status}:${s.title}`)).toEqual(['done:gather dirt', 'active:build walls'])
    expect((await call('POST', '/api/goals/9999/children', { title: 'nope' })).status).toBe(400)
    expect((await call('DELETE', `/api/goals/${goalId}`)).status).toBe(200)
    expect(((await call('GET', '/api/goals')).body as { tree: unknown }).tree).toBeNull()
    expect(events.some((e) => e.type === 'db' && e.data.table === 'goals')).toBe(true)

    const lesson = (await call('POST', '/api/lessons', { content: 'never dig straight down' })).body as { id: number; source: string }
    expect(lesson.source).toBe('player')
    expect((await call('PUT', `/api/lessons/${lesson.id}`, { content: 'never dig down' })).status).toBe(200)
    expect((await call('GET', '/api/lessons')).body).toMatchObject([{ content: 'never dig down' }])
    expect((await call('DELETE', `/api/lessons/${lesson.id}`)).status).toBe(200)

    repos.templates.save('goal', 'build a shelter', ['a', 'b'])
    expect((await call('GET', '/api/templates')).body).toMatchObject([{ name: 'build a shelter', titles: ['a', 'b'] }])
    expect((await call('DELETE', '/api/templates/goal/build%20a%20shelter')).status).toBe(200)
    expect((await call('GET', '/api/days')).body).toEqual([])
    expect(await call('POST', '/api/nap', {})).toEqual({ status: 400, body: { error: 'the bot is offline' } })
  })

  it('switches the brain live, saves settings and hides keys', async () => {
    const { call, events, dir } = await start()
    const res = await call('PUT', '/api/settings', { active: 'anthropic', providers: { anthropic: { effort: 'high', apiKey: '' } } })
    expect(res.body).toMatchObject({ active: 'anthropic', providers: { anthropic: { apiKey: '', hasApiKey: true, effort: 'high' } } })
    expect(events.some((e) => e.type === 'status' && e.data.provider === 'anthropic claude-opus-5-5 (high)')).toBe(true)
    const saved = JSON.parse(readFileSync(join(dir, 'panel.json'), 'utf8'))
    expect(saved).toMatchObject({ active: 'anthropic', providers: { anthropic: { apiKey: 'secret' } } })
  })

  it('answers a model list that cannot be loaded with no models instead of an error', async () => {
    const { call } = await start()
    await call('PUT', '/api/settings', { active: 'openai', providers: { openai: { baseURL: 'http://127.0.0.1:1/v1', model: 'm' } } })
    const res = await call('GET', '/api/models')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ provider: 'openai', current: 'm', models: null, error: expect.any(String) })
  })

  it('lists the models of a provider that is not active yet, for the settings form', async () => {
    const { call } = await start()
    await call('PUT', '/api/settings', { providers: { openai: { baseURL: 'http://127.0.0.1:1/v1', model: 'm' } } })
    expect((await call('GET', '/api/models?provider=openai')).body).toMatchObject({ provider: 'openai', current: 'm', models: null })
    expect((await call('GET', '/api/models?provider=nope')).status).toBe(400)
  })

  it('accepts body-less actions like disconnect when sent as JSON, as the panel does', async () => {
    const { base, call } = await start()
    // Without a JSON content type the server refuses, so other websites can't send commands.
    expect((await fetch(`${base}/api/disconnect`, { method: 'POST' })).status).toBe(400)
    expect(await call('POST', '/api/disconnect', {})).toEqual({ status: 200, body: { ok: true } })
  })

  it('rejects non-JSON writes, bad input, and unknown routes', async () => {
    const { base, call } = await start()
    const form = await fetch(`${base}/api/revelations`, { method: 'POST', body: 'content=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(form.status).toBe(400)
    expect((await call('POST', '/api/connect', { host: 'x', port: 1, username: 'a b', version: '1' })).status).toBe(400)
    expect((await call('GET', '/api/nope')).status).toBe(404)
    expect((await call('PATCH', '/api/memory')).status).toBe(405)
    expect((await fetch(`${base}/`)).status).toBe(503)
  })

  it('serves the built UI with a fallback to index.html and no escapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monacraft-ui-'))
    writeFileSync(join(dir, 'index.html'), '<p>panel</p>')
    const controller = new Controller({ repos: createRepos(openDatabase(':memory:')), settings: defaults(), settingsPath: join(dir, 'panel.json') })
    const server = createPanelServer(controller, { bindHost: '127.0.0.1', staticDir: dir })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    close = () => server.close()
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const home = await fetch(`${base}/`)
    expect(home.headers.get('content-type')).toContain('text/html')
    expect(await home.text()).toBe('<p>panel</p>')
    expect(await (await fetch(`${base}/database`)).text()).toBe('<p>panel</p>')
    expect((await fetch(`${base}/missing.js`)).status).toBe(404)
    expect(await (await fetch(`${base}/..%2fpackage.json`)).text()).toBe('<p>panel</p>')
  })
})

describe('controller usage tracking', () => {
  /** A session whose agent makes one decision per `step()` call, with the given tool outcome. */
  function setup(costs: number[]) {
    const dir = mkdtempSync(join(tmpdir(), 'monacraft-'))
    const repos = createRepos(openDatabase(':memory:'))
    let options: SessionOptions | undefined
    const provider: LLMProvider = {
      name: 'fake',
      decide: async () => ({ thought: '', tool: 'say', args: {}, usage: { inputTokens: 10, outputTokens: 2, cost: costs.shift() } }),
    }
    const startSession = async (o: SessionOptions): Promise<Session> => {
      options = o
      return {
        bot: { username: 'Bot' } as Session['bot'],
        agent: { run: () => new Promise<void>(() => {}), interrupt() {} } as unknown as Session['agent'],
        sleep: {} as Session['sleep'],
        stop() {},
      }
    }
    const settings = applyPatch(defaults(), { active: 'openrouter', providers: { openrouter: { model: 'a/b' } } })
    const controller = new Controller({ repos, settings, settingsPath: join(dir, 'panel.json'), startSession, createProvider: () => provider })
    const steps: MindStep[] = []
    controller.subscribe((e) => e.type === 'step' && steps.push(e.data))
    const step = async (outcome: string) => {
      const o = options!
      o.onAgentEvent?.({ type: 'deciding', promptChars: 1 })
      const decision = await o.provider.decide({ system: '', user: '', tools: [] })
      o.onAgentEvent?.({ type: 'decision', decision })
      o.onAgentEvent?.({ type: 'outcome', tool: decision.tool, outcome })
    }
    const minecraft = { host: 'localhost', port: 25565, username: 'Bot', version: '1.21.11' }
    return { controller, repos, step, steps, connect: () => controller.connect(minecraft) }
  }

  it('records each decision under the session and shows its model and cost on the step', async () => {
    const { controller, repos, step, steps, connect } = setup([0.01, 0.02])
    await connect()
    await step('ok: said')
    await step('error: nobody listened')
    expect(steps.at(-1)).toMatchObject({ model: 'a/b', cost: 0.02, inputTokens: 10, outputTokens: 2 })
    expect(controller.status()).toMatchObject({ model: 'a/b', sessionCost: 0.03 })
    expect(repos.usage.stats()[0]).toMatchObject({ provider: 'openrouter', model: 'a/b', decisions: 2, failed: 1 })
    expect(controller.stats().session).toEqual(controller.stats().allTime)
    controller.disconnect()
  })

  it('never marks an older decision when recording the latest one failed', async () => {
    const { controller, repos, step, connect } = setup([0.01, 0.02])
    await connect()
    await step('ok: said')
    const record = repos.usage.record.bind(repos.usage)
    repos.usage.record = () => {
      throw new Error('disk full')
    }
    await step('error: nobody listened')
    repos.usage.record = record
    expect(repos.usage.stats()[0]).toMatchObject({ decisions: 1, failed: 0 })
    controller.disconnect()
  })

  it('starts a new session on every join', async () => {
    const { controller, step, connect } = setup([0.01, 0.05])
    await connect()
    await step('ok: said')
    controller.disconnect()
    expect(controller.status().sessionCost).toBe(0.01)
    await connect()
    expect(controller.status().sessionCost).toBeNull()
    await step('ok: said')
    expect(controller.stats().session[0]).toMatchObject({ decisions: 1, cost: 0.05 })
    expect(controller.stats().allTime[0]).toMatchObject({ decisions: 2 })
    controller.disconnect()
  })
})
