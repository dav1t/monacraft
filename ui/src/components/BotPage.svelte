<script lang="ts">
  import GoalBar from './GoalBar.svelte'
  import MindFeed from './MindFeed.svelte'
  import PlayerPanel from './PlayerPanel.svelte'
  import RevealInput from './RevealInput.svelte'

  let { onSettings }: { onSettings: () => void } = $props()
</script>

<div class="bot-grid">
  <PlayerPanel {onSettings} />
  <div class="mind-col">
    <GoalBar />
    <MindFeed />
    <RevealInput />
  </div>
</div>
