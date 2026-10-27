<script lang="ts">
  import type { GoalRow, GoalStatus, GoalTree } from '../../../src/web/protocol.ts'
  import { addGoalChild, editGoal, renameGoal, setGoalStatus } from '../lib/actions.ts'
  import { panel } from '../lib/panel.svelte.ts'

  type Subgoal = GoalTree['subgoals'][number]

  const ICONS: Record<GoalStatus, string> = { todo: '☐', active: '▶', done: '✓', failed: '✗', dropped: '–', paused: '⏸' }
  const tree = $derived(panel.goals.tree)
  const last = $derived(panel.goals.past[0])
  const current = $derived(tree?.subgoals.find((s) => s.status === 'active'))
  const position = $derived(tree && current ? `${tree.subgoals.indexOf(current) + 1}/${tree.subgoals.length}` : '')

  // The sub-goal list folds away under the goal, remembered per browser.
  function savedOpen(): boolean {
    try {
      return localStorage.getItem('monacraft.goalTree') !== 'closed'
    } catch {
      return true
    }
  }
  let expanded = $state(savedOpen())
  function toggleExpanded(): void {
    expanded = !expanded
    try {
      localStorage.setItem('monacraft.goalTree', expanded ? 'open' : 'closed')
    } catch {}
  }

  // One sub-goal shows its steps at a time: the active one, or one the player opened.
  let opened = $state<number | null>(null)
  const open = (sub: Subgoal): boolean => (opened === null ? sub.status === 'active' : opened === sub.id)
  function toggle(sub: Subgoal): void {
    opened = open(sub) ? -1 : sub.id
  }
  const doneSteps = (sub: Subgoal): string => {
    const live = sub.steps.filter((s) => s.status !== 'dropped')
    return live.length > 0 ? `${live.filter((s) => s.status === 'done').length}/${live.length} steps` : ''
  }

  /** What the bot is doing right now, from the newest step of the mind feed. */
  const doing = $derived.by(() => {
    if (panel.status?.connection !== 'online') return null
    if (panel.status.brain === 'sleeping') return { what: 'sleeping — reflecting on the day', why: '' }
    const step = panel.steps.at(-1)
    if (!step) return null
    if (!step.decision) return { what: 'thinking…', why: '' }
    const { tool, args, thought } = step.decision
    const detail = Object.values(args)
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(' ')
    const result = step.outcome ? ` → ${step.outcome.length > 80 ? `${step.outcome.slice(0, 79)}…` : step.outcome}` : ''
    return { what: `${tool} ${detail}`.trim() + result, why: thought }
  })
</script>

{#snippet actions(row: GoalRow)}
  <span class="goal-actions">
    <button class="mc-btn tiny" title="Rename" onclick={() => renameGoal(row.id, row.title)}>✎</button>
    {#if row.status === 'active' || row.status === 'todo'}
      <button class="mc-btn tiny" title="Mark done" onclick={() => setGoalStatus(row.id, 'done')}>✓</button>
      <button class="mc-btn tiny danger" title="Drop" onclick={() => setGoalStatus(row.id, 'dropped')}>✕</button>
    {/if}
  </span>
{/snippet}

{#snippet stepList(sub: Subgoal)}
  <ul class="steps">
    {#each sub.steps as step (step.id)}
      <li class="goal-node {step.status}">
        <span class="node-title"><span class="icon">{ICONS[step.status]}</span>{step.title}</span>
        {#if step.attempts > 1}<span class="fails">failed {step.attempts}×</span>{/if}
        {@render actions(step)}
      </li>
    {:else}
      <li class="dim">no steps yet</li>
    {/each}
    <li><button class="mc-btn tiny" onclick={() => addGoalChild(sub.id, 'step')}>+ Step</button></li>
  </ul>
{/snippet}

{#snippet subgoalRow(sub: Subgoal)}
  <li class="goal-node {sub.status}">
    <button class="node-title" aria-expanded={open(sub)} onclick={() => toggle(sub)}>
      <span class="caret">{open(sub) ? '▾' : '▸'}</span><span class="icon">{ICONS[sub.status]}</span>{sub.title}
    </button>
    <span class="dim progress">{doneSteps(sub)}</span>
    {#if sub.attempts > 1}<span class="fails">failed {sub.attempts}×</span>{/if}
    {#if sub.note && sub.status === 'failed'}<span class="dim">— {sub.note}</span>{/if}
    {@render actions(sub)}
    {#if open(sub)}{@render stepList(sub)}{/if}
  </li>
{/snippet}

<div class="dark-panel goal-tree">
  <div class="goal-head">
    <span class="goal-label">Goal</span>
    {#if tree}
      <button class="goal-text node-title" aria-expanded={expanded} onclick={toggleExpanded} title={expanded ? 'Hide sub-goals' : 'Show sub-goals'}>
        <span class="caret">{expanded ? '▾' : '▸'}</span>{tree.goal.title}{#if position}<span class="dim"> · sub-goal {position}</span>{/if}
      </button>
      {@render actions(tree.goal)}
    {:else}
      <span class="goal-text dim">
        No goal — the bot will choose one, or set it here.{#if last} Last: {last.title} ({last.status}).{/if}
      </span>
    {/if}
    <button class="mc-btn small" onclick={editGoal}>New goal</button>
  </div>

  {#if tree && expanded}
    <ol class="subgoals">
      {#each tree.subgoals as sub (sub.id)}
        {@render subgoalRow(sub)}
      {:else}
        <li class="dim">No plan yet — the bot will make one.</li>
      {/each}
      <li><button class="mc-btn tiny" onclick={() => addGoalChild(tree.goal.id, 'sub-goal')}>+ Sub-goal</button></li>
    </ol>
  {/if}

  {#if doing}
    <div class="doing">
      <span class="goal-label">Doing</span>
      <span class="doing-what">{doing.what}</span>
      {#if doing.why}<span class="doing-why">{doing.why}</span>{/if}
    </div>
  {/if}
</div>
