<script lang="ts">
  import { reveal } from '../lib/actions.ts'

  let content = $state('')

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const text = content.trim()
    if (text && (await reveal(text))) content = ''
  }
</script>

<form class="dark-panel reveal-quick" onsubmit={submit}>
  <span class="sparkle">✦</span>
  <input
    class="mc-input"
    bind:value={content}
    maxlength="2000"
    placeholder={'Send a revelation… e.g. "iron ore is common below y=16"'}
    autocomplete="off"
  />
  <button class="mc-btn" type="submit">Reveal</button>
</form>
