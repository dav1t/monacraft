<script lang="ts">
  import type { SlotItem } from '../../../src/web/protocol.ts'
  import { abbreviate, itemColor } from '../lib/items.ts'
  import { tooltip } from '../lib/ui.svelte.ts'

  let { item, selected = false, hint }: { item: SlotItem | null; selected?: boolean; hint?: string | undefined } = $props()

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
    <div class="item-icon" style:background={itemColor(item.name)}>{abbreviate(item.name)}</div>
    {#if item.count > 1}<span class="item-count">{item.count}</span>{/if}
  {/if}
</div>
