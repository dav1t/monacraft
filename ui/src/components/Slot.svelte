<script lang="ts">
  import type { SlotItem } from '../../../src/web/protocol.ts'
  import { abbreviate, itemColor } from '../lib/items.ts'
  import { tooltip } from '../lib/ui.svelte.ts'

  let { item, selected = false, hint }: { item: SlotItem | null; selected?: boolean; hint?: string | undefined } = $props()

  // Item ids without a texture fall back to the colored square.
  let missing = $state<string | null>(null)

  function hover(event: MouseEvent): void {
    if (!item) return
    Object.assign(tooltip, { item, x: event.clientX, y: event.clientY })
  }
</script>

<div
  class="slot"
  class:selected
  class:empty-armor={!item && hint}
  data-hint={hint}
  role="img"
  aria-label={item ? `${item.displayName} x${item.count}` : 'empty slot'}
  onmousemove={hover}
  onmouseleave={() => (tooltip.item = null)}
>
  {#if item}
    {#if missing === item.name}
      <div class="item-icon" style:background={itemColor(item.name)}>{abbreviate(item.name)}</div>
    {:else}
      <img class="item-img" src={`/api/icons/${item.name}.png`} alt="" draggable="false" onerror={() => (missing = item?.name ?? null)} />
    {/if}
    {#if item.count > 1}<span class="item-count">{item.count}</span>{/if}
  {/if}
</div>
