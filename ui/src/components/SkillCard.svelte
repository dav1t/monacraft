<script lang="ts">
  import type { Skill } from '../../../src/web/protocol.ts'
  import { api, attempt } from '../lib/api.ts'
  import { toast } from '../lib/ui.svelte.ts'

  let { skill }: { skill: Skill } = $props()

  // Local drafts; a reload from the server replaces them only when the skill itself changed.
  let description = $state('')
  let code = $state('')
  $effect.pre(() => {
    description = skill.description
    code = skill.code
  })

  const path = $derived(`/api/skills/${encodeURIComponent(skill.name)}`)

  function save(): void {
    attempt(async () => {
      await api('PUT', path, { description, code })
      toast('Skill saved', skill.name)
    })
  }

  function remove(): void {
    if (confirm(`Delete skill “${skill.name}”?`)) attempt(() => api('DELETE', path))
  }
</script>

<div class="skill">
  <div class="skill-head">
    <span class="skill-name">{skill.name}</span>
    <span class="skill-stats"><span class="ok">{skill.successes} ok</span> · <span class="bad">{skill.failures} failed</span></span>
  </div>
  <input class="mc-input" bind:value={description} />
  <textarea class="mc-input" rows={Math.min(18, code.split('\n').length + 1)} spellcheck="false" bind:value={code}></textarea>
  <div class="form-actions">
    <button class="mc-btn small danger" onclick={remove}>Delete</button>
    <button class="mc-btn small" onclick={save}>Save</button>
  </div>
</div>
