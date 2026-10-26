<script lang="ts">
  import HistoryTable from './HistoryTable.svelte'
  import MemoryTable from './MemoryTable.svelte'
  import SkillsList from './SkillsList.svelte'
  import StructuresTable from './StructuresTable.svelte'
  import TemplatesTable from './TemplatesTable.svelte'

  const TABLES = { memory: 'Memory', skills: 'Skills', templates: 'Plan templates', structures: 'Structures', history: 'History' } as const
  let table = $state<keyof typeof TABLES>('memory')
</script>

<div class="subtabs">
  {#each Object.entries(TABLES) as [id, label] (id)}
    <button class="mc-btn small" class:active={table === id} onclick={() => (table = id as keyof typeof TABLES)}>{label}</button>
  {/each}
</div>

{#if table === 'memory'}
  <MemoryTable />
{:else if table === 'skills'}
  <SkillsList />
{:else if table === 'templates'}
  <TemplatesTable />
{:else if table === 'structures'}
  <StructuresTable />
{:else}
  <HistoryTable />
{/if}
