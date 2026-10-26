<script lang="ts">
  import { api } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { toast } from '../lib/ui.svelte.ts'

  let { onJoined }: { onJoined: () => void } = $props()

  let form = $state({ host: '', port: 25565, username: '', version: '' })
  let loaded = false
  // Fill the form once from the saved settings; after that it belongs to the user.
  $effect(() => {
    const saved = panel.settings?.minecraft
    if (!saved || loaded) return
    loaded = true
    form = { ...saved }
  })

  const offline = $derived(panel.status?.connection === 'offline')

  async function join(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const minecraft = { ...form, host: form.host.trim(), username: form.username.trim(), version: form.version.trim(), port: Number(form.port) }
    toast('Connecting', `${minecraft.username} → ${minecraft.host}:${minecraft.port}`)
    try {
      await api('POST', '/api/connect', minecraft)
      onJoined()
    } catch {
      // already shown
    }
  }
</script>

<form class="mc-panel" onsubmit={join}>
  <div class="panel-title">Server</div>
  <label>Server address <input class="mc-input" required bind:value={form.host} /></label>
  <label>Port <input class="mc-input" type="number" min="1" max="65535" required bind:value={form.port} /></label>
  <label>
    Username
    <input class="mc-input" pattern={'\\w{3,16}'} title="3-16 letters, digits or _" required bind:value={form.username} />
  </label>
  <label>Minecraft version <input class="mc-input" required bind:value={form.version} /></label>
  <div class="form-actions">
    <button class="mc-btn" type="submit" disabled={!offline}>Join Server</button>
  </div>
</form>
