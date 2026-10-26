<script lang="ts">
  import type { Day, Lesson } from '../../../src/web/protocol.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { ask, toast } from '../lib/ui.svelte.ts'

  let days = $state<Day[]>([])
  let lessons = $state<Lesson[]>([])
  let draft = $state('')
  let napping = $state(false)

  $effect(() => {
    void panel.versions.days
    attempt(async () => (days = await api<Day[]>('GET', '/api/days?limit=60')))
  })
  $effect(() => {
    void panel.versions.lessons
    attempt(async () => (lessons = await api<Lesson[]>('GET', '/api/lessons')))
  })

  const review = $derived(days[0]?.skills_review ?? [])
  const online = $derived(panel.status?.connection === 'online')

  async function edit(lesson: Lesson): Promise<void> {
    const content = await ask('Edit lesson', lesson.content)
    if (content) attempt(() => api('PUT', `/api/lessons/${lesson.id}`, { content }))
  }

  function add(event: SubmitEvent): void {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return
    attempt(async () => {
      await api('POST', '/api/lessons', { content })
      draft = ''
    })
  }

  function nap(): void {
    napping = true
    toast('Napping', 'The bot pauses and reflects on the day so far')
    api('POST', '/api/nap')
      .catch(() => {})
      .finally(() => (napping = false))
  }
</script>

<div class="journal-grid">
  <div class="mc-panel">
    <div class="panel-title">
      Journal <span class="dim">one entry per sleep or nap</span>
      <button class="mc-btn small" disabled={!online || napping} onclick={nap}>{napping ? 'Reflecting…' : 'Nap now'}</button>
    </div>
    {#each days as day (day.id)}
      <div class="day-card">
        <div class="day-head">
          <span class="kind {day.kind}">{day.kind}</span>
          <span class="dim">{sqlTime(day.started_at)} → {sqlTime(day.ended_at)}</span>
        </div>
        <p>{day.journal}</p>
      </div>
    {:else}
      <p class="dim">No days yet. The bot writes its journal when it sleeps at night (or naps when the day gets long).</p>
    {/each}
  </div>

  <div class="journal-side">
    <div class="mc-panel">
      <div class="panel-title">Lessons <span class="dim">shown to the bot every step (10 newest)</span></div>
      <ol class="lessons">
        {#each lessons as lesson (lesson.id)}
          <li>
            <span class="lesson-text">{lesson.content}</span>
            <span class="kind {lesson.source}">{lesson.source}</span>
            <button class="mc-btn tiny" onclick={() => edit(lesson)}>✎</button>
            <button class="mc-btn tiny danger" onclick={() => attempt(() => api('DELETE', `/api/lessons/${lesson.id}`))}>✕</button>
          </li>
        {:else}
          <li class="dim">No lessons yet.</li>
        {/each}
      </ol>
      <form class="row-form" onsubmit={add}>
        <input class="mc-input grow" maxlength="2000" placeholder="Teach a lesson (sleep keeps yours)" bind:value={draft} />
        <button class="mc-btn small" type="submit">Add</button>
      </form>
    </div>

    <div class="mc-panel">
      <div class="panel-title">Skills to review <span class="dim">flagged at the last sleep</span></div>
      {#if review.length > 0}
        <ul class="review">
          {#each review as name (name)}<li>{name}</li>{/each}
        </ul>
        <p class="dim">Fix them under Database → Skills.</p>
      {:else}
        <p class="dim">Nothing flagged.</p>
      {/if}
    </div>
  </div>
</div>
