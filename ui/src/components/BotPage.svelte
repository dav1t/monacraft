<script lang="ts">
  import GoalTree from './GoalTree.svelte'
  import MindFeed from './MindFeed.svelte'
  import PlayerPanel from './PlayerPanel.svelte'
  import RevealInput from './RevealInput.svelte'

  let { onSettings }: { onSettings: () => void } = $props()
</script>

<div class="bot-grid">
  <PlayerPanel {onSettings} />
  <div class="mind-col">
    <GoalTree />
    <MindFeed />
    <RevealInput />
  </div>
</div>
