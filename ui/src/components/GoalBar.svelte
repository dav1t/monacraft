<script lang="ts">
  import { editGoal } from '../lib/actions.ts'
  import { panel } from '../lib/panel.svelte.ts'
</script>

<div class="dark-panel goal-bar">
  <span class="goal-label">Goal</span>
  <span class="goal-text">{panel.memory.goal ?? '—'}</span>
  <button class="mc-btn small" onclick={editGoal}>Edit</button>
</div>
