<script lang="ts">
  import type { ModelInfo } from '../../../src/web/protocol.ts'

  /** Long lists (OpenRouter has hundreds) are cut to this many matches. */
  const MAX_SHOWN = 200

  let { models, value, onpick }: { models: ModelInfo[]; value: string; onpick: (id: string) => void } = $props()

  let query = $state('')
  let open = $state(false)

  const matches = $derived.by(() => {
    const words = query.trim().toLowerCase()
    return (words ? models.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(words)) : models).slice(0, MAX_SHOWN)
  })

  function pick(id: string): void {
    open = false
    query = ''
    if (id !== value) onpick(id)
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') open = false
    else if (event.key === 'Enter') {
      // Inside a form, Enter would submit it instead of picking.
      event.preventDefault()
      if (matches[0]) pick(matches[0].id)
    } else open = true
  }
</script>

<div class="model-select">
  <input
    class="mc-input"
    placeholder={value}
    aria-label="Search models"
    bind:value={query}
    onfocus={() => (open = true)}
    onclick={() => (open = true)}
    onblur={() => (open = false)}
    {onkeydown}
  />
  {#if open}
    <ul class="model-options">
      {#each matches as model (model.id)}
        <li>
          <!-- mousedown, so the pick lands before the input loses focus and closes the list. -->
          <button type="button" class:active={model.id === value} onmousedown={(e) => (e.preventDefault(), pick(model.id))}>
            {model.name ?? model.id}{#if model.name}<span class="dim"> {model.id}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="dim">No model matches.</li>
      {/each}
    </ul>
  {/if}
</div>
