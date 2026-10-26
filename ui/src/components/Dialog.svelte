<script lang="ts">
  import { dialog } from '../lib/ui.svelte.ts'

  let element: HTMLDialogElement | undefined = $state()
  let input: HTMLTextAreaElement | undefined = $state()

  $effect(() => {
    if (!element || !dialog.open || element.open) return
    element.showModal()
    input?.focus()
  })

  function close(answer: string | null): void {
    element?.close()
    dialog.open = false
    dialog.resolve(answer)
  }
</script>

<dialog class="mc-dialog" bind:this={element} oncancel={() => close(null)}>
  <form
    onsubmit={(event) => {
      event.preventDefault()
      close(dialog.value.trim())
    }}
  >
    <div class="panel-title">{dialog.title}</div>
    <textarea class="mc-input" rows="4" bind:this={input} bind:value={dialog.value}></textarea>
    <div class="form-actions">
      <button class="mc-btn small" type="button" onclick={() => close(null)}>Cancel</button>
      <button class="mc-btn small" type="submit">Done</button>
    </div>
  </form>
</dialog>
