<script lang="ts">
  import { tooltip } from '../lib/ui.svelte.ts'

  let width = $state(0)
  const left = $derived(Math.min(tooltip.x + 16, window.innerWidth - width - 8))
</script>

{#if tooltip.item}
  <div class="tooltip" bind:clientWidth={width} style:left="{left}px" style:top="{tooltip.y - 28}px">
    <div>{tooltip.item.displayName}</div>
    <div class="id">minecraft:{tooltip.item.name}</div>
  </div>
{/if}
