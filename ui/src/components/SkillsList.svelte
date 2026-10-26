<script lang="ts">
  import type { Skill } from '../../../src/web/protocol.ts'
  import { api, attempt } from '../lib/api.ts'
  import { panel } from '../lib/panel.svelte.ts'
  import SkillCard from './SkillCard.svelte'

  let skills = $state<Skill[]>([])

  $effect(() => {
    void panel.versions.skills
    attempt(async () => (skills = await api<Skill[]>('GET', '/api/skills')))
  })
</script>

<div class="mc-panel db-panel">
  <div class="panel-title">Skills <span class="dim">code the bot wrote for itself</span></div>
  {#each skills as skill (skill.name)}
    <SkillCard {skill} />
  {:else}
    <p class="dim">No skills yet. The bot saves routines that worked as skills.</p>
  {/each}
</div>
