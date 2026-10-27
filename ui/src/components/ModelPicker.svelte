<script lang="ts">
  import type { ModelList } from '../../../src/web/protocol.ts'
  import { api, attempt, usd } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { toast } from '../lib/ui.svelte.ts'
  import ModelSearch from './ModelSearch.svelte'

  let list = $state<ModelList | null>(null)

  async function load(refresh = false): Promise<void> {
    list = await api<ModelList>('GET', `/api/models${refresh ? '?refresh=1' : ''}`)
  }

  // Reload when the provider or its setup changes; picking another model keeps the list.
  const setup = $derived.by(() => {
    const settings = panel.settings
    if (!settings) return ''
    const { model: _model, ...rest } = settings.providers[settings.active]
    return JSON.stringify(rest)
  })
  $effect(() => {
    if (setup) attempt(() => load())
  })

  const current = $derived(panel.status?.model ?? list?.current ?? '')

  async function pick(id: string): Promise<void> {
    const settings = panel.settings
    if (!settings) return
    try {
      await api('PUT', '/api/settings', { providers: { [settings.active]: { model: id } } })
      toast('Model switched', `Using ${id} from the next decision`)
    } catch {
      // already shown
    }
  }
</script>

<div class="dark-panel model-picker">
  <span class="panel-heading">Model</span>
  {#if list?.models}
    <ModelSearch models={list.models} value={current} onpick={(id) => attempt(() => pick(id))} />
    <button class="mc-btn tiny" title="Reload the model list" onclick={() => attempt(() => load(true))}>⟳</button>
  {:else}
    <span class="model-current" title={list?.error ?? ''}>{current}</span>
  {/if}
  <span class="session-cost" title="What this session's model calls cost">session {usd(panel.status?.sessionCost)}</span>
</div>
