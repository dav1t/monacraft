<script lang="ts">
  import type { MindStep } from '../../../src/web/protocol.ts'
  import { time } from '../lib/api.ts'

  let { step }: { step: MindStep } = $props()

  let thinkingBox: HTMLDivElement | undefined = $state()
  const done = $derived(!!(step.outcome || step.invalid))
  // `ok: …`, `error: …`, `interrupted: …`, `skipped: …`
  const outcomeKind = $derived(step.outcome?.split(':')[0] ?? '')
  const extraThought = $derived(step.decision?.thought && !step.text.includes(step.decision.thought) ? step.decision.thought : '')

  $effect(() => {
    void step.thinking.length
    if (thinkingBox) thinkingBox.scrollTop = thinkingBox.scrollHeight
  })
</script>

<div class="step" class:live={!done}>
  <div class="step-head"><span class="num">#{step.id}</span><span>{time(step.startedAt)}</span></div>
  {#if step.thinking}<div class="thinking" bind:this={thinkingBox}>{step.thinking}</div>{/if}
  {#if step.text}<div class="text">{step.text}</div>{/if}
  {#if step.decision}
    <div class="call">
      {#if extraThought}<div class="text">{extraThought}</div>{/if}
      <span class="name">→ {step.decision.tool}</span>
      <span class="args">{JSON.stringify(step.decision.args)}</span>
    </div>
  {:else if step.tool}
    <!-- Raw tool-call stream, replaced by the parsed call once the decision is made. -->
    <div class="tool">{step.tool}</div>
  {/if}
  {#if step.invalid}
    <div class="outcome invalid">⚠ {step.invalid}</div>
  {:else if step.outcome}
    <div class="outcome {outcomeKind}">{step.outcome}</div>
  {/if}
</div>
