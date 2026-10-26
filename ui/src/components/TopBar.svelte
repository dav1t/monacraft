<script lang="ts">
  import { api, attempt } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { toast } from '../lib/ui.svelte.ts'

  let { onSettings }: { onSettings: () => void } = $props()

  const status = $derived(panel.status)
  const online = $derived(status?.connection === 'online')

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
      <span class="status-text">{status.username} @ {status.server}</span>
      <span class="status-text dim">{status.provider}</span>
    </div>
    <button class="mc-btn" disabled={status.connection === 'connecting'} onclick={toggle}>
      {status.connection === 'offline' ? 'Connect' : status.connection === 'connecting' ? 'Connecting…' : 'Disconnect'}
    </button>
  {/if}
</header>
