<script lang="ts">
  import { tick } from 'svelte'
  import { panel } from '../lib/panel.svelte.ts'
  import MindStep from './MindStep.svelte'

  let feed: HTMLDivElement | undefined = $state()
  let showThinking = $state(true)
  // Follow new output only while the user is at the bottom, so scrolling up to read is not interrupted.
  let follow = true

  const onscroll = (): void => {
    if (feed) follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
  }

  const last = $derived(panel.steps.at(-1))
  const growth = $derived(
    `${panel.steps.length}:${last?.thinking.length}:${last?.text.length}:${last?.tool.length}:${last?.outcome ?? ''}:${last?.invalid ?? ''}`,
  )

  $effect(() => {
    void growth
    if (!follow) return
    void tick().then(() => feed && (feed.scrollTop = feed.scrollHeight))
  })
</script>

<div class="dark-panel mind" class:no-thinking={!showThinking}>
  <div class="mind-head">
    <span class="panel-heading">Mind</span>
    <label class="check"><input type="checkbox" bind:checked={showThinking} /> show reasoning</label>
  </div>
  <div class="mind-feed" bind:this={feed} {onscroll}>
    {#each panel.steps as step (step.id)}
      <MindStep {step} />
    {:else}
      <div class="empty-note light">The bot’s thoughts will stream here.</div>
    {/each}
  </div>
</div>
