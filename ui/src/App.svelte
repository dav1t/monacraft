<script lang="ts">
  import BotBar from './components/BotBar.svelte'
  import BotPage from './components/BotPage.svelte'
  import DatabasePage from './components/DatabasePage.svelte'
  import Dialog from './components/Dialog.svelte'
  import JournalPage from './components/JournalPage.svelte'
  import LogsPage from './components/LogsPage.svelte'
  import ModelsPage from './components/ModelsPage.svelte'
  import PovPage from './components/PovPage.svelte'
  import RevelationsPage from './components/RevelationsPage.svelte'
  import SettingsPage from './components/SettingsPage.svelte'
  import Toasts from './components/Toasts.svelte'
  import Tooltip from './components/Tooltip.svelte'
  import TopBar from './components/TopBar.svelte'
  import { panel } from './lib/panel.svelte.ts'

  const TABS = { bot: 'Bot', pov: 'POV', revelations: 'Revelations', journal: 'Journal', models: 'Models', logs: 'Logs', database: 'Database', settings: 'Settings' } as const
  type Tab = keyof typeof TABS

  function savedTab(): Tab {
    try {
      const tab = localStorage.getItem('monacraft.tab')
      if (tab && tab in TABS) return tab as Tab
    } catch {}
    return 'bot'
  }

  let tab = $state<Tab>(savedTab())

  function show(next: Tab): void {
    tab = next
    try {
      localStorage.setItem('monacraft.tab', next)
    } catch {}
  }
</script>

<BotBar onAdded={() => show('settings')} />
{#if panel.streamLost}
  <div class="stream-lost">Lost connection to the panel server — retrying…</div>
{/if}
<!-- Everything below belongs to the selected bot; switching bots starts it fresh. -->
{#key panel.botId}
<TopBar onSettings={() => show('settings')} />

<nav class="tabs">
  {#each Object.entries(TABS) as [id, label] (id)}
    <button class="tab" class:active={tab === id} onclick={() => show(id as Tab)}>{label}</button>
  {/each}
</nav>

<main>
  {#if tab === 'bot'}
    <BotPage onSettings={() => show('settings')} />
  {:else if tab === 'pov'}
    <PovPage />
  {:else if tab === 'revelations'}
    <RevelationsPage />
  {:else if tab === 'journal'}
    <JournalPage />
  {:else if tab === 'models'}
    <ModelsPage />
  {:else if tab === 'logs'}
    <LogsPage />
  {:else if tab === 'database'}
    <DatabasePage />
  {:else}
    <SettingsPage onJoined={() => show('bot')} />
  {/if}
</main>
{/key}

<Dialog />
<Tooltip />
<Toasts />
