/**
 * init_experiment — open or reconfigure the autoresearch session.
 *
 * Ported from oh-my-pi `autoresearch/tools/init-experiment.ts` (arktype → zod).
 * On the Phase 1 → Phase 2 transition (or a `new_segment` bump) it requires
 * `./autoresearch.sh` to exist, auto-commits pending harness changes on an
 * autoresearch branch, snapshots HEAD as the baseline, and opens/updates the
 * JSON-store session.
 */

import * as React from 'react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  onExperimentInitialized,
  openAutoresearchStore,
} from '../../autoresearch/index.js'
import {
  commit,
  currentBranch,
  headSha,
  parseWorkDirDirtyPaths,
  stageFiles,
  statusPorcelainZ,
  showPrefix,
} from '../../autoresearch/git.js'
import { dedupeStrings, normalizePathSpec } from '../../autoresearch/helpers.js'
import { buildExperimentState } from '../../autoresearch/state.js'
import type { SessionRow, UpdateSessionParams } from '../../autoresearch/storage.js'
import { isAutoresearchToolAvailable } from '../../autoresearch/index.js'
import { getCwd } from '../../utils/cwd.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { DEFAULT_HARNESS_COMMAND, HARNESS_FILENAME } from './shared.js'

const HARNESS_COMMIT_TITLE = 'autoresearch: harness setup'

const inputSchema = () =>
  z.strictObject({
    name: z.string().describe('experiment name'),
    goal: z.string().optional().describe('session goal'),
    primary_metric: z.string().describe('primary metric name'),
    metric_unit: z.string().optional().describe('metric unit (e.g. ms, µs, mb)'),
    direction: z
      .enum(['lower', 'higher'])
      .optional()
      .describe('better direction (default lower)'),
    secondary_metrics: z.array(z.string()).optional().describe('secondary metric names'),
    scope_paths: z.array(z.string()).optional().describe('expected-to-modify paths'),
    off_limits: z.array(z.string()).optional().describe('off-limits paths'),
    constraints: z.array(z.string()).optional().describe('free-form constraints'),
    max_iterations: z.number().optional().describe('soft iteration cap per segment'),
    new_segment: z
      .boolean()
      .optional()
      .describe('bump to a new segment in existing session'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>
type Output = { text: string }

export const InitExperimentTool: Tool<InputSchema, Output> = buildTool({
  name: 'init_experiment',
  searchHint: 'open or reconfigure the autoresearch session (Phase 1 → Phase 2)',
  maxResultSizeChars: 8_000,
  async description() {
    return 'Initialize or reconfigure the autoresearch session. On first call requires `./autoresearch.sh` to exist; pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.'
  },
  async prompt() {
    return 'Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition) `./autoresearch.sh` must exist and emit `METRIC name=value`; it is committed as the baseline on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Init Experiment'
  },
  isEnabled() {
    return isAutoresearchToolAvailable()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  renderToolUseMessage(input: Input) {
    return `init_experiment ${input?.name ?? ''}`.trim()
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('init_experiment cannot be used in agent contexts')
    }
    const cwd = getCwd()
    const store = await openAutoresearchStore()

    const direction = input.direction ?? 'lower'
    const metricUnit = input.metric_unit ?? ''
    const scopePaths = dedupeStrings((input.scope_paths ?? []).map(normalizePathSpec))
    const offLimits = dedupeStrings((input.off_limits ?? []).map(normalizePathSpec))
    const constraints = dedupeStrings(input.constraints ?? [])
    const secondaryMetrics = dedupeStrings(input.secondary_metrics ?? [])
    const goal = input.goal?.trim() || null
    const maxIterations =
      input.max_iterations !== undefined &&
      Number.isFinite(input.max_iterations) &&
      input.max_iterations > 0
        ? Math.floor(input.max_iterations)
        : null
    const branch = await currentBranch()
    const onAutoresearchBranch = branch?.startsWith('autoresearch/') ?? false

    const existing = store.getActiveSessionForBranch(branch)
    const isNewSegmentInit = existing !== null && input.new_segment === true
    const requiresHarness = !existing || isNewSegmentInit

    if (requiresHarness && !existsSync(join(cwd, HARNESS_FILENAME))) {
      return {
        data: {
          text: `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call init_experiment again.`,
        },
      }
    }

    let harnessCommitted = false
    let commitWarning: string | null = null
    if (requiresHarness && onAutoresearchBranch) {
      const dirty = await detectPendingChanges()
      if (dirty) {
        try {
          await stageFiles([])
          await commit(buildHarnessCommitMessage(goal, input.name))
          harnessCommitted = true
        } catch (err) {
          commitWarning = `Failed to auto-commit harness changes: ${err instanceof Error ? err.message : String(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`
        }
      }
    }

    const baselineCommit = await headSha()

    let session: SessionRow
    let createdSession = false
    let bumpedSegment = false
    let abandonedRuns = 0

    if (!existing) {
      session = await store.openSession({
        name: input.name,
        goal,
        primaryMetric: input.primary_metric,
        metricUnit,
        direction,
        preferredCommand: DEFAULT_HARNESS_COMMAND,
        branch,
        baselineCommit,
        maxIterations,
        scopePaths,
        offLimits,
        constraints,
        secondaryMetrics,
      })
      createdSession = true
    } else {
      abandonedRuns = await store.abandonPendingRuns(existing.id)
      const updates: UpdateSessionParams = {
        goal,
        maxIterations,
        scopePaths,
        offLimits,
        constraints,
        secondaryMetrics,
        primaryMetric: input.primary_metric,
        metricUnit,
        direction,
        branch,
      }
      if (isNewSegmentInit) updates.baselineCommit = baselineCommit
      let updated = await store.updateSession(existing.id, updates)
      if (isNewSegmentInit) {
        updated = await store.bumpSegment(existing.id)
        bumpedSegment = true
      }
      session = updated
    }

    buildExperimentState(session, store.listLoggedRuns(session.id))
    onExperimentInitialized(session.goal, session.branch)

    const lines: string[] = []
    if (abandonedRuns > 0) {
      lines.push(
        `Abandoned ${abandonedRuns} pending run${abandonedRuns === 1 ? '' : 's'} before reconfiguring.`,
      )
    }
    if (harnessCommitted && session.baselineCommit) {
      lines.push(`Committed harness setup at ${session.baselineCommit.slice(0, 12)}.`)
    }
    if (commitWarning) lines.push(commitWarning)
    if (createdSession) {
      lines.push(`Started session #${session.id}: ${session.name}`)
    } else if (bumpedSegment) {
      lines.push(
        `Bumped segment to ${session.currentSegment} for session #${session.id}: ${session.name}`,
      )
    } else {
      lines.push(
        `Updated session #${session.id} (segment ${session.currentSegment}): ${session.name}`,
      )
    }
    lines.push(
      `Metric: ${session.primaryMetric} (${session.metricUnit || 'unitless'}, ${session.direction} is better)`,
    )
    lines.push(`Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`)
    if (session.scopePaths.length > 0) lines.push(`Files in scope: ${session.scopePaths.join(', ')}`)
    if (session.offLimits.length > 0) lines.push(`Off limits: ${session.offLimits.join(', ')}`)
    if (session.maxIterations !== null) {
      lines.push(`Max iterations per segment: ${session.maxIterations}`)
    }
    if (session.branch) lines.push(`Active branch: ${session.branch}`)
    if (session.baselineCommit) {
      lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`)
    }
    if (createdSession) {
      lines.push(
        'Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.',
      )
    } else if (bumpedSegment) {
      lines.push('Run a fresh baseline for the new segment.')
    }
    if (requiresHarness && !onAutoresearchBranch) {
      lines.push(
        'Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.',
      )
    }

    return { data: { text: lines.join('\n') } }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function detectPendingChanges(): Promise<boolean> {
  try {
    const statusText = await statusPorcelainZ()
    const workDirPrefix = await showPrefix().catch(() => '')
    return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0
  } catch {
    return false
  }
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
  const lines = [HARNESS_COMMIT_TITLE, '', `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`]
  if (goal) {
    lines.push(`Goal: ${goal}`)
  } else {
    lines.push(`Session: ${name}`)
  }
  return lines.join('\n')
}
