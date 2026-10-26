<script lang="ts">
  import { api, attempt } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { toast } from '../lib/ui.svelte.ts'

  let { onSettings }: { onSettings: () => void } = $props()

  const status = $derived(panel.status)
  const online = $derived(status?.connection === 'online')

  const k = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))
  /** How full the context window is, 0..1, when the window is known. */
  const used = $derived(status?.contextTokens ? status.promptTokens / status.contextTokens : null)
  const gaugeTitle = $derived.by(() => {
    if (!status) return ''
    const what = `${status.promptTokensEstimated ? 'About ' : ''}${status.promptTokens} tokens read for the last decision (system prompt, tools and prompt)`
    const window = status.contextTokens
      ? `, of a ${status.contextTokens}-token context window. The reply (and its thinking) needs room too; near full, raise the context window or the model forgets the start.`
      : '.'
    return what + window
  })

  function toggle(): void {
    if (online) return attempt(() => api('POST', '/api/disconnect'))
    const minecraft = panel.settings?.minecraft
    if (!minecraft) return onSettings()
    toast('Connecting', `${minecraft.username} → ${minecraft.host}:${minecraft.port}`)
    attempt(() => api('POST', '/api/connect', minecraft))
  }
</script>

<header class="topbar">
  <div class="logo">MINDFART<span class="splash">Revelations!</span></div>
  {#if status}
    <div class="status">
      <span class="badge {status.connection}">{status.connection}</span>
      <span class="badge {online ? status.brain : ''}">brain: {online ? status.brain : 'off'}</span>
      {#if online && status.promptTokens > 0}
        <span class="gauge" title={gaugeTitle}>
          {#if used !== null}
            <span class="gauge-fill" class:high={used > 0.75} style="width: {Math.min(100, used * 100)}%"></span>
          {/if}
          <span class="gauge-text">
            {status.promptTokensEstimated ? '~' : ''}{k(status.promptTokens)}{status.contextTokens ? ` / ${k(status.contextTokens)}` : ''} tok
          </span>
        </span>
      {/if}
      <span class="status-text">{status.username} @ {status.server}</span>
      <span class="status-text dim">{status.provider}</span>
    </div>
    <button class="mc-btn" disabled={status.connection === 'connecting'} onclick={toggle}>
      {status.connection === 'offline' ? 'Connect' : status.connection === 'connecting' ? 'Connecting…' : 'Disconnect'}
    </button>
  {/if}
</header>
