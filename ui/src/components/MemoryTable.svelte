<script lang="ts">
  import { api, attempt } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { ask } from '../lib/ui.svelte.ts'

  let key = $state('')
  let value = $state('')

  const path = (k: string): string => `/api/memory/${encodeURIComponent(k)}`

  async function edit(k: string, current: string): Promise<void> {
    const next = await ask(`Edit “${k}”`, current)
    if (next) attempt(() => api('PUT', path(k), { value: next }))
  }

  function togglePin(k: string, pinned: boolean): void {
    attempt(() => api('PUT', `${path(k)}/pin`, { pinned: !pinned }))
  }

  function remove(k: string): void {
    if (confirm(`Forget “${k}”?`)) attempt(() => api('DELETE', path(k)))
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    if (!key.trim() || !value.trim()) return
    attempt(async () => {
      await api('PUT', path(key.trim()), { value: value.trim() })
      key = value = ''
    })
  }
</script>

<div class="mc-panel db-panel">
  <div class="panel-title">Memory <span class="dim">facts the bot remembers</span></div>
  <table class="mc-table">
    <thead><tr><th title="Pinned facts are never changed or deleted by sleep">📌</th><th>Key</th><th>Value</th><th></th></tr></thead>
    <tbody>
      {#each panel.memory as { key: k, value: v, pinned } (k)}
        <tr class:pinned>
          <td class="actions">
            <button class="mc-btn tiny" class:active={pinned} title={pinned ? 'Unpin' : 'Pin: sleep never changes or deletes it'} onclick={() => togglePin(k, pinned)}>📌</button>
          </td>
          <td>{k}</td>
          <td>{v}</td>
          <td class="actions">
            <button class="mc-btn small" onclick={() => edit(k, v)}>Edit</button>
            <button class="mc-btn small danger" onclick={() => remove(k)}>Delete</button>
          </td>
        </tr>
      {:else}
        <tr><td colspan="4" class="dim">The bot remembers nothing yet.</td></tr>
      {/each}
    </tbody>
  </table>
  <form class="row-form" onsubmit={submit}>
    <input class="mc-input" placeholder="key" required bind:value={key} />
    <input class="mc-input grow" placeholder="value" required bind:value />
    <button class="mc-btn small" type="submit">Add / update</button>
  </form>
</div>
