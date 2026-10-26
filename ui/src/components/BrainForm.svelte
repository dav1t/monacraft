<script lang="ts">
  import type { ProviderId, PublicSettings } from '../../../src/web/protocol.ts'
  import { api } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { toast } from '../lib/ui.svelte.ts'

  const PROVIDERS: Record<ProviderId, string> = { ollama: 'Ollama', openai: 'OpenAI-compatible', anthropic: 'Anthropic' }
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

  let picked = $state<ProviderId>('ollama')
  let draft = $state<PublicSettings['providers'] | null>(null)
  // The <select> needs strings; Ollama's think setting is boolean or a level.
  let think = $state('false')

  // Fill the form from the saved settings once; later server updates must not overwrite typing.
  $effect(() => {
    const settings = panel.settings
    if (!settings || draft) return
    draft = $state.snapshot(settings.providers) as PublicSettings['providers']
    picked = settings.active
    think = String(settings.providers.ollama.think)
  })

  const active = $derived(panel.settings?.active)

  async function apply(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!draft) return
    const providers =
      picked === 'ollama'
        ? { ollama: { ...draft.ollama, think: think === 'true' ? true : think === 'false' ? false : think, numCtx: Number(draft.ollama.numCtx) } }
        : picked === 'openai'
          ? { openai: { baseURL: draft.openai.baseURL, model: draft.openai.model, apiKey: draft.openai.apiKey } }
          : { anthropic: { model: draft.anthropic.model, effort: draft.anthropic.effort, apiKey: draft.anthropic.apiKey } }
    try {
      const saved = await api<PublicSettings>('PUT', '/api/settings', { active: picked, providers })
      // Keys are never echoed back; clear the typed key and show "stored" instead.
      draft = $state.snapshot(saved.providers) as PublicSettings['providers']
      toast('Brain applied', `Using ${PROVIDERS[picked]} from the next decision`)
    } catch {
      // already shown
    }
  }

  const keyPlaceholder = (stored: boolean): string => (stored ? 'stored ✓ — leave empty to keep' : 'not set')
</script>

<form class="mc-panel" onsubmit={apply}>
  <div class="panel-title">Brain <span class="dim">changes apply live, from the next decision</span></div>
  <div class="provider-pick">
    {#each Object.entries(PROVIDERS) as [id, label] (id)}
      <button type="button" class="mc-btn small" class:active={picked === id} onclick={() => (picked = id as ProviderId)}>
        {label}{active === id ? ' ✓' : ''}
      </button>
    {/each}
  </div>

  {#if draft}
    {#if picked === 'ollama'}
      <label>Host <input class="mc-input" bind:value={draft.ollama.host} /></label>
      <label>Model <input class="mc-input" bind:value={draft.ollama.model} /></label>
      <label>
        Mode
        <select class="mc-input" bind:value={draft.ollama.mode}>
          <option value="tools">tools (native tool calling)</option>
          <option value="json">json (any model)</option>
        </select>
      </label>
      <label>
        Thinking
        <select class="mc-input" bind:value={think}>
          <option value="false">off</option>
          <option value="true">on</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <label>Context window <input class="mc-input" type="number" min="2048" step="1024" bind:value={draft.ollama.numCtx} /></label>
    {:else if picked === 'openai'}
      <label>Base URL <input class="mc-input" placeholder="https://api.openai.com/v1" bind:value={draft.openai.baseURL} /></label>
      <label>Model <input class="mc-input" bind:value={draft.openai.model} /></label>
      <label>
        API key
        <input class="mc-input" type="password" autocomplete="off" placeholder={keyPlaceholder(draft.openai.hasApiKey)} bind:value={draft.openai.apiKey} />
      </label>
      <p class="hint dark">Works with OpenAI, OpenRouter, LM Studio (http://localhost:1234/v1), llama.cpp, Groq…</p>
    {:else}
      <label>Model <input class="mc-input" bind:value={draft.anthropic.model} /></label>
      <label>
        Effort
        <select class="mc-input" bind:value={draft.anthropic.effort}>
          {#each EFFORTS as effort (effort)}<option>{effort}</option>{/each}
        </select>
      </label>
      <label>
        API key
        <input class="mc-input" type="password" autocomplete="off" placeholder={keyPlaceholder(draft.anthropic.hasApiKey)} bind:value={draft.anthropic.apiKey} />
      </label>
      <p class="hint dark">Leave the key empty to use ANTHROPIC_API_KEY from the environment.</p>
    {/if}
  {/if}

  <div class="form-actions">
    <button class="mc-btn" type="submit">Apply brain</button>
  </div>
</form>
