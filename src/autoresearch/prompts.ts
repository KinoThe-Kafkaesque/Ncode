/**
 * Autoresearch prompt templates (ported VERBATIM from oh-my-pi
 * `autoresearch/prompt-setup.md`, `prompt.md`, `command-resume.md`,
 * `resume-message.md`) plus a small mustache/handlebars-ish renderer.
 *
 * oh-my-pi renders these with `prompt.render` (handlebars). ncode has no
 * handlebars dependency, so `render()` below implements the subset the templates
 * use: `{{var}}` interpolation, `{{#if}}` / `{{#unless}}` / `{{else}}`, and
 * `{{#each}}` blocks with per-item scope. The `{{base_system_prompt}}` slot is
 * left empty here — ncode injects these as a per-turn `<autoresearch_context>`
 * system-reminder attachment, NOT as a replacement system prompt, so the base
 * prompt is supplied separately by the host.
 */

// === prompt-setup.md (Phase 1: harness setup) ===============================
export const SETUP_PROMPT_TEMPLATE = `{{base_system_prompt}}

## Autoresearch Mode — Phase 1: Harness Setup

Autoresearch mode is active and there is no session yet. Your job in this turn is to **build the benchmark harness**, not to optimise anything. Optimisation starts only after you call \`init_experiment\`.

{{#if has_goal}}
Primary goal (for context — implement the harness so it can measure this):
{{goal}}
{{else}}
There is no goal recorded yet. Infer what to optimise from the latest user message and design the harness to measure that. Capture the goal when you call \`init_experiment\`.
{{/if}}

Working directory: \`{{working_dir}}\`
{{#if has_branch}}Active branch: \`{{branch}}\`{{/if}}
{{#if has_baseline_warning}}

{{baseline_warning}}
{{/if}}

### What you MUST produce

Write \`./autoresearch.sh\` at the working directory. It is the canonical benchmark entrypoint and MUST:

- exit 0 on success and non-zero on failure;
- print the primary metric as a single line \`METRIC <name>=<value>\`;
- print any secondary metrics as additional \`METRIC <name>=<value>\` lines;
- run the same workload deterministically every time (no live network, no time-of-day dependencies, fixed seeds where applicable).

You MAY edit anything else needed to make \`autoresearch.sh\` work — benchmark binaries, \`Cargo.toml\`, \`package.json\`, helper scripts, fixtures. All those edits are part of the harness baseline and will be committed for you when you call \`init_experiment\` on an autoresearch branch.

### Steps

1. Inspect the target. Read source, identify what to measure, decide on the workload.
2. Write \`autoresearch.sh\` plus any supporting files (benchmark binaries, fixtures, etc.).
3. Validate it: invoke \`bash autoresearch.sh\` through the regular \`bash\` tool. Confirm it exits 0 and emits at least one \`METRIC\` line. Iterate on the harness until it does.
4. Call \`init_experiment\` with the goal, primary metric (matching the \`METRIC\` name), and scope. This snapshots the worktree as the baseline and starts Phase 2 (the iteration loop).

### Rules

- NEVER call \`run_experiment\`, \`log_experiment\`, or \`update_notes\` yet. They will error with "no active autoresearch session" until \`init_experiment\` runs.
- NEVER treat a compile-only check as a benchmark. The harness MUST actually execute the workload and emit \`METRIC\`.
- NEVER create \`autoresearch.md\`, \`autoresearch.checks.sh\`, \`autoresearch.program.md\`, \`autoresearch.ideas.md\`, \`autoresearch.jsonl\`, \`.autoresearch/\`, or \`autoresearch.config.json\`. Session state is tracked for you.`

// === prompt.md (Phase 2: iteration loop) ====================================
export const ITERATION_PROMPT_TEMPLATE = `{{base_system_prompt}}

## Autoresearch Mode

Autoresearch mode is active.

{{#if has_goal}}
Primary goal:
{{goal}}
{{else}}
There is no goal recorded for this session yet. Infer what to optimize from the latest user message and the conversation; capture the goal in your notes (\`update_notes\`) once it is clear.
{{/if}}

Session state and run artifacts are managed for you. The benchmark entrypoint is \`bash autoresearch.sh\` (committed during Phase 1). NEVER edit \`autoresearch.sh\` mid-segment unless you intentionally bump segment via \`init_experiment new_segment: true\`. NEVER create \`autoresearch.md\` or \`.autoresearch/\` in this repo.

Working directory: \`{{working_dir}}\`
{{#if has_branch}}Active branch: \`{{branch}}\`{{/if}}
{{#if has_baseline_commit}}Baseline commit: \`{{baseline_commit}}\`{{/if}}

You are running an autonomous experiment loop. You MUST keep iterating until the user interrupts you or the configured maximum iteration count is reached.

### Available tools
- \`init_experiment\` — open or reconfigure the session. Pass \`new_segment: true\` to start a fresh baseline within the current session.
- \`run_experiment\` — run the benchmark (\`bash autoresearch.sh\`). Output is captured automatically and \`METRIC name=value\` / \`ASI key=value\` lines printed by the harness are parsed back to you. The command is fixed.
- \`log_experiment\` — record the result. On \`keep\`, modified files are committed for you; on \`discard\`/\`crash\`/\`checks_failed\`, the worktree is reverted. Pass \`flag_runs\` to mark earlier runs as suspect; flagged runs are excluded from baseline and best-metric math.
- \`update_notes\` — replace the durable session playbook (\`body\`) or append to the ideas backlog (\`append_idea\`). The notes are injected into your system prompt every iteration.

### Operating protocol
1. Understand the target before touching code: read source, identify the bottleneck, verify prerequisites and benchmark inputs.
2. Update goal, scope, or constraints via another \`init_experiment\` call (no segment bump) or \`update_notes\`. Bump segment when you intentionally change \`autoresearch.sh\`.
3. Establish a baseline first.
4. Iterate: change code, run \`run_experiment\`, log honestly with \`log_experiment\`. One coherent experiment per iteration.
5. Keep the primary metric as the decision maker:
   - \`keep\` when it improves;
   - \`discard\` when it regresses or stays flat;
   - \`crash\` when the run fails;
   - \`checks_failed\` when validation fails (you decide what validation means; run it through the regular \`bash\` tool).
6. Use ASI freely — it is opaque, just stash useful learnings (\`hypothesis\`, \`rollback_reason\`, \`next_action_hint\`, anything else).
7. When confidence is low, re-run promising changes before keeping them. \`log_experiment\` reports a confidence score (multiples of the observed noise floor) on each kept run.

### Scope, off-limits, and accountability
- Edits are not blocked. You can change anything.
- \`log_experiment\` records the modified paths. Files outside \`scope_paths\` or inside \`off_limits\` are recorded as \`scope_deviations\` on the run.
- If you keep a run with deviations, pass \`justification\` explaining why. Without it, the run logs but is flagged in the next iteration's prompt as unjustified.
- If a previous run looks reward-hacked or otherwise wrong, pass \`flag_runs: [{ run_id, reason }]\` on the next \`log_experiment\` to exclude it from baseline and best-metric calculations.

{{#if has_notes}}
### Your notes (use \`update_notes\` to edit)

{{notes}}

{{/if}}
{{#if has_recent_results}}
### Current segment snapshot
- segment: \`{{current_segment}}\`
- runs in current segment: \`{{current_segment_run_count}}\`
{{#if has_baseline_metric}}
- baseline \`{{metric_name}}\`: \`{{baseline_metric_display}}\`
{{/if}}
{{#if has_best_result}}
- best kept \`{{metric_name}}\`: \`{{best_metric_display}}\`{{#if best_run_number}} from run \`#{{best_run_number}}\`{{/if}}
{{/if}}

Recent runs:
{{#each recent_results}}
- run \`#{{run_number}}\`: \`{{status}}\` \`{{metric_display}}\` — {{description}}
{{#if has_asi_summary}}
  ASI: {{asi_summary}}
{{/if}}
{{#if has_deviations}}
  Modified outside scope: {{deviations}}{{#unless justified}} (no justification){{/unless}}
{{/if}}
{{#if flagged}}
  FLAGGED: {{flagged_reason}}
{{/if}}
{{/each}}
{{/if}}
{{#if has_unjustified_runs}}

### Unjustified deviations
{{#each unjustified_runs}}
- run \`#{{run_number}}\` modified \`{{paths}}\` outside scope without justification. Either accept it, justify it on the next log, or \`flag_runs\` it.
{{/each}}
{{/if}}
{{#if has_pending_run}}

### Pending run
An unlogged run is waiting:
- run: \`#{{pending_run_number}}\`
- command: \`{{pending_run_command}}\`
{{#if has_pending_run_metric}}
- parsed \`{{metric_name}}\`: \`{{pending_run_metric_display}}\`
{{/if}}
- result: {{#if pending_run_passed}}passed{{else}}failed{{/if}}

Finish the \`log_experiment\` step before starting another benchmark.
{{/if}}

### Guardrails
- NEVER game the benchmark.
- NEVER overfit to synthetic inputs if the real workload is broader.
- MUST preserve correctness.
- If the user sends another message while a run is in progress, finish the current run and logging cycle first, then address the new input in the next iteration.`

// === command-resume.md ======================================================
export const COMMAND_RESUME_TEMPLATE = `Resume autoresearch on the active session.

{{branch_status_line}}
{{#if has_resume_context}}

Additional context from the user:

{{resume_context}}
{{/if}}

- Use the active session context above as the source of truth for goal, scope, constraints, and run history.
- Inspect recent git history for context.
- Continue the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.`

// === resume-message.md ======================================================
export const RESUME_MESSAGE_TEMPLATE = `Continue the autoresearch loop now.

- Re-read your notes and the recent-runs context above before deciding the next direction.
- Inspect recent git history for context.
{{#if has_pending_run}}
- A previous benchmark run completed but was never logged. Finish \`log_experiment\` before starting a new run.
{{/if}}
- Continue from the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.
- Preserve correctness and do not game the benchmark.`

// === Minimal handlebars-ish renderer ========================================

type TemplateValue = unknown
export type TemplateData = Record<string, TemplateValue>

interface TextNode {
  kind: 'text'
  value: string
}
interface VarNode {
  kind: 'var'
  name: string
}
interface SectionNode {
  kind: 'if' | 'unless' | 'each'
  name: string
  body: Node[]
  alt: Node[]
}
type Node = TextNode | VarNode | SectionNode

const TAG = /\{\{\s*([#/]?[^{}]+?)\s*\}\}/g

/**
 * Drop the leading indentation and trailing newline of any line that contains
 * only a block tag (`{{#…}}`, `{{/…}}`, `{{else}}`). Mirrors handlebars
 * "standalone" whitespace handling so block markers don't leave blank lines.
 */
function stripStandaloneBlockLines(template: string): string {
  return template.replace(
    /^[ \t]*(\{\{\s*(?:#(?:if|unless|each)\b[^{}]*|\/(?:if|unless|each)|else)\s*\}\})[ \t]*\r?\n/gm,
    '$1',
  )
}

function tokenize(template: string): Array<{ type: 'text' | 'tag'; value: string }> {
  const tokens: Array<{ type: 'text' | 'tag'; value: string }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  TAG.lastIndex = 0
  while ((match = TAG.exec(template)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: template.slice(lastIndex, match.index) })
    }
    tokens.push({ type: 'tag', value: match[1]!.trim() })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < template.length) {
    tokens.push({ type: 'text', value: template.slice(lastIndex) })
  }
  return tokens
}

function parse(
  tokens: Array<{ type: 'text' | 'tag'; value: string }>,
  start: number,
  closer: string | null,
): { nodes: Node[]; next: number; hitElse: boolean } {
  const nodes: Node[] = []
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.type === 'text') {
      nodes.push({ kind: 'text', value: token.value })
      i += 1
      continue
    }
    const tag = token.value
    if (closer && (tag === closer || tag === 'else')) {
      return { nodes, next: i + 1, hitElse: tag === 'else' }
    }
    if (tag.startsWith('#')) {
      const [keyword, ...rest] = tag.slice(1).split(/\s+/)
      const kind = keyword as 'if' | 'unless' | 'each'
      const name = rest.join(' ')
      const close = `/${keyword}`
      const body = parse(tokens, i + 1, close)
      let alt: Node[] = []
      let next = body.next
      if (body.hitElse) {
        const elseBranch = parse(tokens, body.next, close)
        alt = elseBranch.nodes
        next = elseBranch.next
      }
      nodes.push({ kind, name, body: body.nodes, alt })
      i = next
      continue
    }
    if (tag.startsWith('/')) {
      // Unbalanced close — stop.
      return { nodes, next: i + 1, hitElse: false }
    }
    nodes.push({ kind: 'var', name: tag })
    i += 1
  }
  return { nodes, next: i, hitElse: false }
}

function lookup(scopes: TemplateData[], name: string): TemplateValue {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i]!
    if (Object.prototype.hasOwnProperty.call(scope, name)) {
      return scope[name]
    }
  }
  return undefined
}

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

function renderNodes(nodes: Node[], scopes: TemplateData[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value
    } else if (node.kind === 'var') {
      const value = lookup(scopes, node.name)
      out += value === undefined || value === null ? '' : String(value)
    } else if (node.kind === 'if') {
      out += truthy(lookup(scopes, node.name))
        ? renderNodes(node.body, scopes)
        : renderNodes(node.alt, scopes)
    } else if (node.kind === 'unless') {
      out += !truthy(lookup(scopes, node.name))
        ? renderNodes(node.body, scopes)
        : renderNodes(node.alt, scopes)
    } else {
      const value = lookup(scopes, node.name)
      if (Array.isArray(value) && value.length > 0) {
        for (const item of value) {
          const frame: TemplateData =
            item && typeof item === 'object'
              ? (item as TemplateData)
              : { this: item }
          out += renderNodes(node.body, [...scopes, frame])
        }
      } else {
        out += renderNodes(node.alt, scopes)
      }
    }
  }
  return out
}

export function render(template: string, data: TemplateData): string {
  const tokens = tokenize(stripStandaloneBlockLines(template))
  const { nodes } = parse(tokens, 0, null)
  const rendered = renderNodes(nodes, [data])
  // Collapse runs of 3+ newlines to 2, and trim the empty base-prompt prefix.
  return rendered.replace(/\n{3,}/g, '\n\n').trimStart()
}

export function renderSetupPrompt(data: TemplateData): string {
  return render(SETUP_PROMPT_TEMPLATE, { base_system_prompt: '', ...data })
}

export function renderIterationPrompt(data: TemplateData): string {
  return render(ITERATION_PROMPT_TEMPLATE, { base_system_prompt: '', ...data })
}

export function renderCommandResume(data: TemplateData): string {
  return render(COMMAND_RESUME_TEMPLATE, data)
}

export function renderResumeMessage(data: TemplateData): string {
  return render(RESUME_MESSAGE_TEMPLATE, data)
}
