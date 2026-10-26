<script lang="ts">
  import type { PlanTemplate } from '../../../src/web/protocol.ts'
  import { api, attempt, sqlTime } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'

  let templates = $state<PlanTemplate[]>([])

  $effect(() => {
    void panel.versions.templates
    void panel.versions.goals
    attempt(async () => (templates = await api<PlanTemplate[]>('GET', '/api/templates')))
  })

  function remove(t: PlanTemplate): void {
    if (confirm(`Delete the plan template “${t.name}”?`)) {
      attempt(async () => {
        await api('DELETE', `/api/templates/${t.kind}/${encodeURIComponent(t.name)}`)
        templates = templates.filter((x) => x !== t)
      })
    }
  }
</script>

<div class="mc-panel db-panel">
  <div class="panel-title">Plan templates <span class="dim">plans that worked, reused for similar goals</span></div>
  <table class="mc-table">
    <thead><tr><th>Kind</th><th>Name</th><th>Plan</th><th>Used</th><th>Result</th><th>Updated</th><th></th></tr></thead>
    <tbody>
      {#each templates as t (`${t.kind}:${t.name}`)}
        <tr>
          <td><span class="kind {t.kind}">{t.kind}</span></td>
          <td>{t.name}{#if t.flagged} <span class="bad">failing</span>{/if}</td>
          <td>{t.titles.join(' → ')}</td>
          <td class="num">{t.uses}</td>
          <td class="num"><span class="ok">{t.successes} ok</span> · <span class="bad">{t.failures} failed</span></td>
          <td class="time">{sqlTime(t.updated_at)}</td>
          <td class="actions"><button class="mc-btn small danger" onclick={() => remove(t)}>Delete</button></td>
        </tr>
      {:else}
        <tr><td colspan="7" class="dim">No templates yet. They are saved when a goal or sub-goal is completed.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
