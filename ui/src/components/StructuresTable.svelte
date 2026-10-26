<script lang="ts">
  import type { Structure } from '../../../src/web/protocol.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'

  let structures = $state<Structure[]>([])

  $effect(() => {
    void panel.versions.structures
    attempt(async () => (structures = await api<Structure[]>('GET', '/api/structures')))
  })

  function remove(s: Structure): void {
    if (confirm(`Forget the structure “${s.name}”? (The blocks stay in the world.)`)) {
      attempt(() => api('DELETE', `/api/structures/${encodeURIComponent(s.name)}`))
    }
  }

  const size = (s: Structure): string =>
    s.shape === 'pillar' ? `${s.height} high` : s.shape === 'floor' ? `${s.width}×${s.depth}` : `${s.width}×${s.depth}×${s.height}`
</script>

<div class="mc-panel db-panel">
  <div class="panel-title">Structures <span class="dim">what the build tool put up — the bot sees these as “Built”</span></div>
  <table class="mc-table">
    <thead><tr><th>Name</th><th>Shape</th><th>Size</th><th>Block</th><th>Corner</th><th>Blocks</th><th>Updated</th><th></th></tr></thead>
    <tbody>
      {#each structures as s (s.name)}
        <tr>
          <td>{s.name}</td>
          <td>{s.shape}</td>
          <td class="num">{size(s)}</td>
          <td>{s.block}</td>
          <td class="num">{s.x} {s.y} {s.z} ({s.facing})</td>
          <td class="num"><span class={s.status === 'complete' ? 'ok' : 'bad'}>{s.placed}/{s.total}</span></td>
          <td class="time">{sqlTime(s.updated_at)}</td>
          <td class="actions"><button class="mc-btn small danger" onclick={() => remove(s)}>Forget</button></td>
        </tr>
      {:else}
        <tr><td colspan="8" class="dim">Nothing built yet. The bot records what it builds with the build tool.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
