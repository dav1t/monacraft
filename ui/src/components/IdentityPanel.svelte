<script lang="ts">
  import type { Identity, Scar } from '../../../src/web/protocol.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { ask } from '../lib/ui.svelte.ts'

  let versions = $state<Identity[]>([])
  let scars = $state<Scar[]>([])
  let showHistory = $state(false)

  $effect(() => {
    void panel.versions.identity
    attempt(async () => (versions = await api<Identity[]>('GET', '/api/identity')))
  })
  $effect(() => {
    void panel.versions.scars
    attempt(async () => (scars = await api<Scar[]>('GET', '/api/scars')))
  })

  const current = $derived(versions[0])
  const birth = $derived(versions.find((v) => v.reason === 'birth'))

  async function edit(): Promise<void> {
    if (!current) return
    const self = await ask('Who the bot is (first person)', current.self)
    if (!self) return
    const wants = await ask('What it wants now', current.wants)
    if (wants) attempt(() => api('PUT', '/api/identity', { self, wants }))
  }
</script>

<div class="mc-panel">
  <div class="panel-title">
    Who I am <span class="dim">written by the bot; shown every step</span>
    {#if current}<button class="mc-btn small" onclick={edit}>Edit</button>{/if}
  </div>
  {#if current}
    <p class="identity-self">{current.self}</p>
    <p class="identity-wants"><b>Wants:</b> {current.wants}</p>
    <div class="identity-meta dim">
      <span class="kind {current.reason}">{current.reason}</span>
      {sqlTime(current.created_at)}
      {#if birth?.seeds}· born with <i>{birth.seeds}</i>{/if}
    </div>
    {#if versions.length > 1}
      <button class="mc-btn tiny" onclick={() => (showHistory = !showHistory)}>
        {showHistory ? 'Hide' : 'Show'} how it changed ({versions.length - 1} earlier)
      </button>
      {#if showHistory}
        {#each versions.slice(1) as version (version.id)}
          <div class="day-card">
            <div class="day-head">
              <span class="kind {version.reason}">{version.reason}</span>
              <span class="dim">{sqlTime(version.created_at)}</span>
            </div>
            <p>{version.self}</p>
            <p><b>Wanted:</b> {version.wants}</p>
          </div>
        {/each}
      {/if}
    {/if}
  {:else}
    <p class="dim">Not born yet. The bot writes who it is the first time it connects.</p>
  {/if}
</div>

<div class="mc-panel">
  <div class="panel-title">Scars <span class="dim">deaths and what they meant</span></div>
  <ol class="lessons">
    {#each scars as scar (scar.id)}
      <li>
        <span class="lesson-text">
          <b>{scar.cause}</b> at {scar.place} <span class="dim">({sqlTime(scar.created_at)}; lost {scar.lost})</span>
          {#if scar.meaning}<br />“{scar.meaning}”{/if}
        </span>
        <button class="mc-btn tiny danger" onclick={() => attempt(() => api('DELETE', `/api/scars/${scar.id}`))}>✕</button>
      </li>
    {:else}
      <li class="dim">No deaths yet.</li>
    {/each}
  </ol>
</div>
