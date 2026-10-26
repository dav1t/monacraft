<script lang="ts">
  import BrainForm from './BrainForm.svelte'
  import ServerForm from './ServerForm.svelte'

  let { onJoined }: { onJoined: () => void } = $props()
</script>

<div class="settings-grid">
  <ServerForm {onJoined} />
  <BrainForm />
</div>
