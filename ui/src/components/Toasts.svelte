<script lang="ts">
  import { toasts } from '../lib/ui.svelte.ts'
</script>

<div class="toasts">
  {#each toasts as toast (toast.id)}
    <div class="toast" class:error={toast.error}>
      <div class="t-title">{toast.title}</div>
      <div>{toast.text}</div>
    </div>
  {/each}
</div>
