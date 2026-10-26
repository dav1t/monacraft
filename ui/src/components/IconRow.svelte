<script lang="ts">
  import type { IconSet } from '../lib/pixel.ts'

  /** Ten icons for a 0-20 value, like the health and hunger bars. */
  let { value, icons, title, right = false }: { value: number; icons: IconSet; title: string; right?: boolean } = $props()

  const pictures = $derived(
    Array.from({ length: 10 }, (_, i) => {
      const points = value - i * 2
      return points >= 2 ? icons.full : points === 1 ? icons.half : icons.empty
    }),
  )
</script>

<div class="icon-row" class:right class:low={value <= 6} {title}>
  {#each pictures as src, i (i)}<img {src} alt="" />{/each}
</div>
