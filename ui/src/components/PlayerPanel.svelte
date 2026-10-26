<script lang="ts">
  import { panel } from '../lib/panel.svelte.ts'
  import { DRUMSTICKS, HEARTS } from '../lib/pixel.ts'
  import IconRow from './IconRow.svelte'
  import Slot from './Slot.svelte'

  let { onSettings }: { onSettings: () => void } = $props()

  const ARMOR_HINTS = ['⛑', '👕', '👖', '👢']
  const player = $derived(panel.player)
</script>

<div class="mc-panel player">
  <div class="panel-title">
    <span>{player?.username ?? 'Not connected'}</span>
    <span class="dim">{player?.gameMode ?? ''}</span>
  </div>

  {#if !player}
    <div class="empty-note">
      Connect the bot to a server to see its state.<br />
      <button class="mc-btn small" onclick={onSettings}>Open server settings</button>
    </div>
  {:else}
    <div class="bars">
      <IconRow value={Math.ceil(player.health)} icons={HEARTS} title="Health {Math.ceil(player.health)}/20" />
      <IconRow value={player.food} icons={DRUMSTICKS} right title="Food {player.food}/20, saturation {player.saturation.toFixed(1)}" />
    </div>
    <div class="xp">
      <div class="xp-fill" style:width="{Math.round(player.xp.progress * 100)}%"></div>
      {#if player.xp.level > 0}<span class="xp-level">{player.xp.level}</span>{/if}
    </div>

    <dl class="facts">
      <dt>Position</dt><dd>{player.position.join(' ')}</dd>
      <dt>Dimension</dt><dd>{player.dimension}</dd>
      <dt>Biome</dt><dd>{player.biome}</dd>
      <dt>Time</dt><dd>{player.time.label} ({player.time.ticks})</dd>
      <dt>Weather</dt><dd>{player.weather}</dd>
    </dl>

    <div class="label">Armor &amp; offhand</div>
    <div class="slots armor">
      {#each player.armor as item, i (i)}<Slot {item} hint={ARMOR_HINTS[i]} />{/each}
      <Slot item={player.offhand} hint="🛡" />
    </div>

    <div class="label">Inventory</div>
    <div class="slots grid9">
      {#each player.main as item, i (i)}<Slot {item} />{/each}
    </div>
    <div class="slots grid9 hotbar">
      {#each player.hotbar as item, i (i)}<Slot {item} selected={i === player.selectedSlot} />{/each}
    </div>

    <div class="label">Nearby</div>
    <ul class="entities">
      {#each player.entities as entity, i (i)}
        <li class:hostile={entity.hostile}><span>{entity.label}</span><span>{entity.distance}m</span></li>
      {:else}
        <li class="dim">nothing nearby</li>
      {/each}
    </ul>
  {/if}
</div>
