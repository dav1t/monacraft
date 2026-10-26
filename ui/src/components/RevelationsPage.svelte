<script lang="ts">
  import type { Revelation } from '../../../src/web/protocol.ts'
  import { editGoal, reveal } from '../lib/actions.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { ask } from '../lib/ui.svelte.ts'

  let revelations = $state<Revelation[]>([])
  let draft = $state('')

  $effect(() => {
    void panel.versions.revelations
    attempt(async () => (revelations = await api<Revelation[]>('GET', '/api/revelations')))
  })

  async function edit(revelation: Revelation): Promise<void> {
    const content = await ask('Edit revelation', revelation.content)
    if (content) attempt(() => api('PUT', `/api/revelations/${revelation.id}`, { content }))
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const text = draft.trim()
    if (text && (await reveal(text))) draft = ''
  }
</script>

<div class="book">
  <h2>Revelations</h2>
  <p class="hint">
    Revelations sit at the top of every prompt, above everything else, until you remove them. Use them to give the bot a
    helping hand with its goal. Adding one interrupts the current action so the bot reconsiders right away.
  </p>
  <div class="book-goal">
    <span>Current goal:</span> <strong>{panel.memory.goal ?? '—'}</strong>
    <button class="mc-btn small" onclick={editGoal}>Edit goal</button>
  </div>

  {#if revelations.length === 0}
    <p class="hint">No revelations yet. The bot is on its own.</p>
  {:else}
    <ol class="revelations">
      {#each revelations as revelation (revelation.id)}
        <li>
          <div class="rev-row">
            <div class="rev-text">
              {revelation.content}
              <div class="rev-time">{sqlTime(revelation.created_at)}</div>
            </div>
            <button class="mc-btn small" onclick={() => edit(revelation)}>Edit</button>
            <button class="mc-btn small danger" onclick={() => attempt(() => api('DELETE', `/api/revelations/${revelation.id}`))}>Remove</button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}

  <form class="reveal-form" onsubmit={submit}>
    <textarea class="mc-input" rows="3" maxlength="2000" placeholder="Write a new revelation…" bind:value={draft}></textarea>
    <button class="mc-btn" type="submit">Add revelation</button>
  </form>
</div>
