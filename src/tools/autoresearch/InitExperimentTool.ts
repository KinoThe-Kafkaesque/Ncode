/**
 * init_experiment — open or reconfigure the autoresearch session.
 *
 * Ported from oh-my-pi `autoresearch/tools/init-experiment.ts` (arktype → zod).
 * On the Phase 1 → Phase 2 transition (or a `new_segment` bump) it requires
 * `.auto/measure.sh` (or legacy `autoresearch.sh`) to exist, auto-commits
 * pending harness changes on an autoresearch branch, snapshots HEAD as the
 * baseline, and appends a config header to `.auto/log.jsonl`. On first
 * activation it fires the `before` lifecycle hook.
 */

import * as React from 'react'
import { existsSync } from 'node:fs'
import { z } from 'zod/v4'
import {
  onExperimentInitialized,
  isAutoresearchToolAvailable,
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
import {
  buildExperimentState,
  currentResults,
  findBaselineMetric,
  findBestKeptMetric,
} from '../../autoresearch/state.js'
import {
  appendConfigHeader,
  readLastRunEntry,
  sessionLogExists,
} from '../../autoresearch/storage.js'
import { sessionFilePath } from '../../autoresearch/paths.js'
import {
  appendHookLogEntryIfConfigured,
  runHook,
  steerMessageFor,
  type BeforeHookPayload,
  type SessionSnapshot,
} from '../../autoresearch/hooks.js'
import { getCwd } from '../../utils/cwd.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'

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
    return 'Initialize or reconfigure the autoresearch session. On first call requires `.auto/measure.sh` to exist; pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.'
  },
  async prompt() {
    return 'Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition) `.auto/measure.sh` must exist and emit `METRIC name=value`; it is committed as the baseline on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.'
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
    const workDir = getCwd()

    const direction = input.direction ?? 'lower'
    const metricUnit = input.metric_unit ?? ''
    const scopePaths = dedupeStrings((input.scope_paths ?? []).map(normalizePathSpec))
    const offLimits = dedupeStrings((input.off_limits ?? []).map(normalizePathSpec))
    const constraints = dedupeStrings(input.constraints ?? [])
    const goal = input.goal?.trim() || null
    const maxIterations =
      input.max_iterations !== undefined &&
      Number.isFinite(input.max_iterations) &&
      input.max_iterations > 0
        ? Math.floor(input.max_iterations)
        : null
    const branch = await currentBranch()
    const onAutoresearchBranch = branch?.startsWith('autoresearch/') ?? false

    const harnessPath = sessionFilePath(workDir, 'measure')
    const harnessRelPath = harnessPath.startsWith(workDir + '/')
      ? harnessPath.slice(workDir.length + 1)
      : harnessPath
    const harnessCommand = `bash ${harnessRelPath}`

    const existing = sessionLogExists(workDir)
    const isNewSegmentInit = existing && input.new_segment === true
    const requiresHarness = !existing || isNewSegmentInit

    if (requiresHarness && !existsSync(harnessPath)) {
      return {
        data: {
          text: `Error: ./${harnessRelPath} does not exist. Phase 1 of autoresearch is harness setup — write \`./${harnessRelPath}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${harnessRelPath}\`, then call init_experiment again.`,
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
          await commit(buildHarnessCommitMessage(goal, input.name, harnessCommand))
          harnessCommitted = true
        } catch (err) {
          commitWarning = `Failed to auto-commit harness changes: ${err instanceof Error ? err.message : String(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`
        }
      }
    }

    const baselineCommit = await headSha()

    appendConfigHeader(workDir, {
      name: input.name,
      metricName: input.primary_metric,
      metricUnit,
      bestDirection: direction,
      goal,
      scopePaths,
      offLimits,
      constraints,
      maxIterations,
      baselineCommit,
    })

    const state = buildExperimentState(workDir)
    onExperimentInitialized(state.goal, branch)

    const lines: string[] = []
    if (harnessCommitted && state.baselineCommit) {
      lines.push(`Committed harness setup at ${state.baselineCommit.slice(0, 12)}.`)
    }
    if (commitWarning) lines.push(commitWarning)
    if (!existing) {
      lines.push(`Started session: ${input.name}`)
    } else if (isNewSegmentInit) {
      lines.push(`Bumped segment to ${state.currentSegment} for session: ${state.name ?? input.name}`)
    } else {
      lines.push(`Updated session (segment ${state.currentSegment}): ${state.name ?? input.name}`)
    }
    lines.push(
      `Metric: ${state.metricName} (${state.metricUnit || 'unitless'}, ${state.bestDirection} is better)`,
    )
    lines.push(`Benchmark entrypoint: ${harnessCommand}`)
    if (state.scopePaths.length > 0) lines.push(`Files in scope: ${state.scopePaths.join(', ')}`)
    if (state.offLimits.length > 0) lines.push(`Off limits: ${state.offLimits.join(', ')}`)
    if (state.maxExperiments !== null) {
      lines.push(`Max iterations per segment: ${state.maxExperiments}`)
    }
    if (branch) lines.push(`Active branch: ${branch}`)
    if (state.baselineCommit) {
      lines.push(`Baseline commit: ${state.baselineCommit.slice(0, 12)}`)
    }
    if (!existing) {
      lines.push(
        'Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.',
      )
    } else if (isNewSegmentInit) {
      lines.push('Run a fresh baseline for the new segment.')
    }
    if (requiresHarness && !onAutoresearchBranch) {
      lines.push(
        'Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.',
      )
    }

    // Fire the `before` hook on first activation (no prior session existed).
    if (!existing) {
      const lastRun = readLastRunEntry(workDir)
      const runNumbers = state.results
        .map(r => r.runNumber)
        .filter((n): n is number => n !== null)
      const nextRun = runNumbers.length > 0 ? Math.max(...runNumbers) + 1 : 1
      const snapshot: SessionSnapshot = {
        metric_name: state.metricName,
        metric_unit: state.metricUnit,
        direction: state.bestDirection,
        baseline_metric: findBaselineMetric(state.results, state.currentSegment),
        best_metric: findBestKeptMetric(state.results, state.currentSegment, state.bestDirection),
        run_count: currentResults(state.results, state.currentSegment).length,
        goal: state.goal ?? '',
      }
      const payload: BeforeHookPayload = {
        event: 'before',
        cwd: workDir,
        next_run: nextRun,
        last_run: lastRun,
        session: snapshot,
      }
      const hookResult = await runHook(payload)
      const jsonlPath = sessionFilePath(workDir, 'log')
      appendHookLogEntryIfConfigured(jsonlPath, 'before', hookResult)
      const steer = steerMessageFor('before', hookResult)
      if (steer) lines.push(steer)
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

function buildHarnessCommitMessage(goal: string | null, name: string, harnessCommand: string): string {
  const lines = [HARNESS_COMMIT_TITLE, '', `Benchmark entrypoint: ${harnessCommand}`]
  if (goal) {
    lines.push(`Goal: ${goal}`)
  } else {
    lines.push(`Session: ${name}`)
  }
  return lines.join('\n')
}
