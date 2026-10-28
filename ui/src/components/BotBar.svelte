<script lang="ts">
  import type { BotSummary } from '../../../src/web/protocol.ts'
  import { api, attempt } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import { ask, toast } from '../lib/ui.svelte.ts'

  let { onAdded }: { onAdded: () => void } = $props()

  const selected = $derived(panel.bots.find((b) => b.id === panel.botId))

  /** A new bot with an empty mind; it starts with the selected bot's server and brain settings. */
  async function add(): Promise<void> {
    const username = await ask('Name of the new bot (3-16 letters, digits or _)')
    if (!username) return
    try {
      const bot = await api<BotSummary>('POST', '/api/bots', { username, ...(panel.botId && { from: panel.botId }) })
      toast('Bot added', `${bot.username} has a mind of its own`)
      panel.select(bot.id)
      onAdded()
    } catch {
      // already shown
    }
  }

  function remove(bot: BotSummary): void {
    if (!confirm(`Remove ${bot.username} from the panel? Its memory stays on disk but the panel forgets it.`)) return
    attempt(() => api('DELETE', `/api/bots/${encodeURIComponent(bot.id)}`))
  }
</script>

<div class="botbar">
  {#each panel.bots as bot (bot.id)}
    <button class="bot-chip" class:selected={bot.id === panel.botId} title="{bot.server} · {bot.provider}" onclick={() => panel.select(bot.id)}>
      <span class="bot-dot {bot.connection}"></span>
      {bot.username}
      {#if bot.connection === 'online'}<span class="dim">{bot.brain}</span>{/if}
    </button>
  {/each}
  <div class="botbar-actions">
    {#if selected && selected.connection === 'offline' && panel.bots.length > 1}
      <button class="mc-btn small danger" onclick={() => remove(selected)}>Remove</button>
    {/if}
    <button class="mc-btn small" onclick={add}>+ Bot</button>
  </div>
</div>
