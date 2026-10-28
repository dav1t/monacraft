<script lang="ts">
  import { panel } from '../lib/panel.svelte.ts'

  const online = $derived(panel.status?.connection === 'online')
</script>

<div class="dark-panel pov-panel">
  {#if online}
    <!-- Remounted on every join: the viewer's socket ends with the bot it was watching. -->
    {#key `${panel.botId}/${panel.status?.username}`}
      <iframe class="pov-frame" src={`/pov/${encodeURIComponent(panel.botId ?? '')}/`} title="What the bot sees"></iframe>
    {/key}
  {:else}
    <div class="empty-note light">The bot is offline. Connect it to see through its eyes.</div>
  {/if}
</div>
