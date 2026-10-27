<script lang="ts">
  import type { ModelStats } from '../../../src/web/protocol.ts'
  import { api, attempt, usd } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'

  let stats = $state<{ session: ModelStats[]; allTime: ModelStats[] }>({ session: [], allTime: [] })

  $effect(() => {
    void panel.versions.llm_calls
    attempt(async () => (stats = await api('GET', '/api/stats')))
  })

  const tables = $derived([
    { title: 'This session', hint: 'since the bot last joined', rows: stats.session },
    { title: 'All time', hint: 'every model you have tried', rows: stats.allTime },
  ])
  const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
</script>

{#each tables as table (table.title)}
  <div class="mc-panel db-panel">
    <div class="panel-title">{table.title} <span class="dim">{table.hint}</span></div>
    <table class="mc-table">
      <thead>
        <tr><th>Model</th><th>Decisions</th><th title="Unusable replies, failed requests and tool calls that returned an error">Failed</th><th>Tokens in / out</th><th>Cost</th><th>Avg s</th></tr>
      </thead>
      <tbody>
        {#each table.rows as row (`${row.provider} ${row.model}`)}
          <tr>
            <td>{row.model} <span class="dim">{row.provider}</span></td>
            <td class="num">{row.decisions}</td>
            <td class="num">{row.failed}{row.decisions ? ` (${Math.round((row.failed / row.decisions) * 100)}%)` : ''}</td>
            <td class="num">{tokens(row.inputTokens)} / {tokens(row.outputTokens)}</td>
            <td class="num">{usd(row.cost)}</td>
            <td class="num">{row.avgSeconds === null ? '—' : row.avgSeconds.toFixed(1)}</td>
          </tr>
        {:else}
          <tr><td colspan="6" class="dim">No model calls yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/each}
