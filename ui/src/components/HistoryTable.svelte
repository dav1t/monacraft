<script lang="ts">
  import type { HistoryEntry } from '../../../src/web/protocol.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'

  const PAGE = 100
  let entries = $state<HistoryEntry[]>([])
  let more = $state(false)

  async function load(before?: number): Promise<void> {
    const page = await api<HistoryEntry[]>('GET', `/api/history?limit=${PAGE}${before ? `&before=${before}` : ''}`)
    entries = before ? [...entries, ...page] : page
    more = page.length === PAGE
  }

  // History grows every step, so reloads are throttled to one every few seconds.
  let timer: ReturnType<typeof setTimeout> | null = null
  let first = true
  $effect(() => {
    void panel.versions.history
    if (first) {
      first = false
      attempt(() => load())
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      attempt(() => load())
    }, 3000)
  })
  $effect(() => () => {
    if (timer) clearTimeout(timer)
  })

  function clearAll(): void {
    if (confirm('Delete the whole history? The bot loses its recent context.')) attempt(() => api('DELETE', '/api/history'))
  }
</script>

<div class="mc-panel db-panel">
  <div class="panel-title">
    History <span class="dim">newest first</span>
    <button class="mc-btn small danger" onclick={clearAll}>Clear all</button>
  </div>
  <table class="mc-table">
    <thead><tr><th>#</th><th>Kind</th><th>Content</th><th>Time</th><th></th></tr></thead>
    <tbody>
      {#each entries as entry (entry.id)}
        <tr>
          <td class="num">{entry.id}</td>
          <td><span class="kind {entry.kind}">{entry.kind}</span></td>
          <td>{entry.content}</td>
          <td class="time">{sqlTime(entry.created_at)}</td>
          <td class="actions">
            <button class="mc-btn small danger" onclick={() => attempt(() => api('DELETE', `/api/history/${entry.id}`))}>✕</button>
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="dim">No history yet.</td></tr>
      {/each}
    </tbody>
  </table>
  {#if more}
    <button class="mc-btn small more" onclick={() => attempt(() => load(entries.at(-1)?.id))}>Load more</button>
  {/if}
</div>
