<script lang="ts">
  import { tick } from 'svelte'
  import { time } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'

  let filter = $state('')
  let follow = $state(true)
  let clearedBefore = $state(0)
  let feed: HTMLDivElement | undefined = $state()

  const visible = $derived.by(() => {
    const needle = filter.trim().toLowerCase()
    return panel.logs.filter((entry) => entry.id > clearedBefore && (!needle || entry.text.toLowerCase().includes(needle)))
  })

  function kind(text: string): string {
    if (text.startsWith('💭')) return 'thought'
    if (text.startsWith('⚡')) return 'reflex'
    if (text.startsWith('⚠') || text.startsWith('kicked') || text.startsWith('bot error')) return 'warn'
    if (text.startsWith('✨')) return 'reveal'
    if (text.startsWith('🧠')) return 'brain'
    return ''
  }

  $effect(() => {
    void visible.length
    if (follow) void tick().then(() => feed && (feed.scrollTop = feed.scrollHeight))
  })
</script>

<div class="dark-panel logs-panel">
  <div class="logs-tools">
    <input class="mc-input" placeholder="Filter…" autocomplete="off" bind:value={filter} />
    <label class="check"><input type="checkbox" bind:checked={follow} /> follow</label>
    <button class="mc-btn small" onclick={() => (clearedBefore = panel.logs.at(-1)?.id ?? 0)}>Clear view</button>
  </div>
  <div class="log-feed" bind:this={feed}>
    {#each visible as entry (entry.id)}
      <div class="log-line {kind(entry.text)}"><span class="time">{time(entry.time)}</span>{entry.text}</div>
    {/each}
  </div>
</div>
